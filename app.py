from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from functools import wraps
import json
import os

app = Flask(__name__)
secret_key = os.environ.get('SECRET_KEY')
if not secret_key:
    if os.environ.get('RENDER') or os.environ.get('FLASK_ENV') == 'production':
        raise RuntimeError('SECRET_KEY environment variable is required in production.')
    secret_key = 'hiking-dev-key-change-in-prod'

app.config['SECRET_KEY'] = secret_key
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///hiking.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)


def init_db():
    os.makedirs(app.instance_path, exist_ok=True)
    db.create_all()


# ── Models ─────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    routes = db.relationship('Route', backref='user', lazy=True)
    logs = db.relationship('HikeLog', backref='user', lazy=True)

    def set_password(self, pw): self.password_hash = generate_password_hash(pw)
    def check_password(self, pw): return check_password_hash(self.password_hash, pw)

    @property
    def total_km(self):
        return round(sum(r.distance_km or 0 for r in self.routes), 1)

    @property
    def total_elevation(self):
        return sum(r.elevation_gain_m or 0 for r in self.routes)

    @property
    def hikes_completed(self):
        return len(self.logs)


DIFFICULTY_LABELS = {'easy': 'Facile', 'medium': 'Medio', 'hard': 'Difficile', 'expert': 'Esperto'}
DIFFICULTY_COLORS = {'easy': 'success', 'medium': 'warning', 'hard': 'orange', 'expert': 'danger'}

TRAIL_TYPE_LABELS = {
    'T':   'T — Turistico',
    'E':   'E — Escursionistico',
    'EE':  'EE — Escursionisti Esperti',
    'EEA': 'EEA — Ferrata / Attrezzato',
    'F':   'F — Facile (alpinismo)',
    'PD':  'PD — Poco Difficile',
    'AD':  'AD — Abbastanza Difficile',
    'D':   'D — Difficile',
    'TD':  'TD — Molto Difficile',
    'ED':  'ED — Estremo',
}

ROUTE_TYPE_LABELS = {
    'punto_punto':    'Punto a punto',
    'anello':         'Anello',
    'andata_ritorno': 'Andata e ritorno',
    'multiday':       'Multi-giorno',
}

SURFACE_LABELS = {
    'sentiero':  'Sentiero segnalato',
    'sterrato':  'Sterrato / mulattiera',
    'roccioso':  'Roccioso',
    'neve':      'Neve / ghiacciaio',
    'misto':     'Misto',
}

HAZARD_META = {
    'esposto':  ('bi-exclamation-triangle-fill', 'warning',   'Tratti esposti'),
    'ferrata':  ('bi-ladder',                    'danger',    'Via ferrata'),
    'neve':     ('bi-snow2',                     'primary',   'Neve'),
    'ghiaccio': ('bi-thermometer-snow',          'info',      'Ghiaccio'),
    'valanghe': ('bi-cloud-snow-fill',           'danger',    'Rischio valanghe'),
    'fiume':    ('bi-water',                     'primary',   'Guado / fiume'),
    'tecnico':  ('bi-tools',                     'secondary', 'Terreno tecnico'),
    'roccia':   ('bi-triangle-fill',             'secondary', 'Roccia'),
}


class Route(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    difficulty = db.Column(db.String(20), default='medium')
    # Trail metadata
    trail_type = db.Column(db.String(10), default='E')
    route_type_tag = db.Column(db.String(20), default='punto_punto')
    surface = db.Column(db.String(30), default='sentiero')
    ferrata_grade = db.Column(db.String(20), nullable=True)
    hazards_json = db.Column(db.Text, default='[]')
    # Metrics
    distance_km = db.Column(db.Float, default=0.0)
    elevation_gain_m = db.Column(db.Integer, default=0)
    elevation_loss_m = db.Column(db.Integer, default=0)
    max_elevation_m = db.Column(db.Integer, nullable=True)
    min_elevation_m = db.Column(db.Integer, nullable=True)
    duration_min = db.Column(db.Float, default=0.0)
    avg_slope_pct = db.Column(db.Float, nullable=True)
    max_slope_asc_pct = db.Column(db.Float, nullable=True)
    max_slope_desc_pct = db.Column(db.Float, nullable=True)
    # Geometry
    waypoints_json = db.Column(db.Text, default='[]')
    geometry_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    logs = db.relationship('HikeLog', backref='route', lazy=True, cascade='all, delete-orphan')

    @property
    def waypoints(self):
        return json.loads(self.waypoints_json or '[]')

    @property
    def hazards(self):
        return json.loads(self.hazards_json or '[]')

    @property
    def difficulty_label(self):
        return DIFFICULTY_LABELS.get(self.difficulty, 'Medio')

    @property
    def difficulty_color(self):
        return DIFFICULTY_COLORS.get(self.difficulty, 'warning')

    @property
    def trail_type_label(self):
        return TRAIL_TYPE_LABELS.get(self.trail_type, self.trail_type or 'E')

    @property
    def route_type_label(self):
        return ROUTE_TYPE_LABELS.get(self.route_type_tag, self.route_type_tag or '—')

    @property
    def surface_label(self):
        return SURFACE_LABELS.get(self.surface, self.surface or '—')

    @property
    def hazard_meta(self):
        return [(h, HAZARD_META[h]) for h in self.hazards if h in HAZARD_META]

    @staticmethod
    def slope_color(pct):
        if pct is None: return 'secondary'
        v = abs(pct)
        if v < 10: return 'success'
        if v < 20: return 'warning'
        if v < 30: return 'orange'
        return 'danger'

    def duration_str(self):
        m = int(self.duration_min or 0)
        if m < 60:
            return f"{m}min"
        return f"{m // 60}h {m % 60:02d}min"

    def time_ago(self):
        delta = datetime.utcnow() - self.created_at
        if delta.days >= 1:
            return f"{delta.days}g fa"
        h = delta.seconds // 3600
        if h >= 1:
            return f"{h}h fa"
        return f"{delta.seconds // 60}min fa"

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description or '',
            'difficulty': self.difficulty,
            'trail_type': self.trail_type,
            'route_type_tag': self.route_type_tag,
            'surface': self.surface,
            'ferrata_grade': self.ferrata_grade,
            'hazards': self.hazards,
            'distance_km': self.distance_km,
            'elevation_gain_m': self.elevation_gain_m,
            'elevation_loss_m': self.elevation_loss_m,
            'max_elevation_m': self.max_elevation_m,
            'min_elevation_m': self.min_elevation_m,
            'duration_min': self.duration_min,
            'avg_slope_pct': self.avg_slope_pct,
            'max_slope_asc_pct': self.max_slope_asc_pct,
            'max_slope_desc_pct': self.max_slope_desc_pct,
            'waypoints': self.waypoints,
            'geometry': json.loads(self.geometry_json) if self.geometry_json else None,
        }


class HikeLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    route_id = db.Column(db.Integer, db.ForeignKey('route.id'), nullable=False)
    date = db.Column(db.Date, nullable=False)
    duration_min = db.Column(db.Integer, nullable=True)
    notes = db.Column(db.Text, nullable=True)
    rating = db.Column(db.Integer, nullable=True)  # 1-5
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


# ── Helpers ────────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def current_user():
    uid = session.get('user_id')
    return db.session.get(User, uid) if uid else None


@app.context_processor
def inject_user():
    return {
        'current_user': current_user(),
        'now': datetime.utcnow(),
        'HAZARD_META': HAZARD_META,
        'TRAIL_TYPE_LABELS': TRAIL_TYPE_LABELS,
    }


# ── Auth ───────────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user():
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            session['user_id'] = user.id
            return redirect(url_for('index'))
        flash('Username o password non validi.', 'error')
    return render_template('auth/login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user():
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        if not all([username, email, password]):
            flash('Tutti i campi sono obbligatori.', 'error')
        elif User.query.filter_by(username=username).first():
            flash('Username già in uso.', 'error')
        elif User.query.filter_by(email=email).first():
            flash('Email già in uso.', 'error')
        elif len(password) < 6:
            flash('Password minimo 6 caratteri.', 'error')
        else:
            user = User(username=username, email=email)
            user.set_password(password)
            db.session.add(user)
            db.session.commit()
            session['user_id'] = user.id
            return redirect(url_for('index'))
    return render_template('auth/register.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ── Pages ──────────────────────────────────────────────────────────────────

@app.route('/')
@login_required
def index():
    user = current_user()
    recent = Route.query.filter_by(user_id=user.id)\
        .order_by(Route.created_at.desc()).limit(4).all()
    total_routes = Route.query.filter_by(user_id=user.id).count()
    return render_template('index.html', recent=recent, total_routes=total_routes)


@app.route('/map')
@login_required
def map_view():
    route_id = request.args.get('route_id', type=int)
    route = None
    if route_id:
        route = Route.query.filter_by(id=route_id, user_id=current_user().id).first()
    return render_template('map.html', route=route)


@app.route('/routes')
@login_required
def routes_list():
    user = current_user()
    difficulty = request.args.get('difficulty', '')
    q = Route.query.filter_by(user_id=user.id)
    if difficulty:
        q = q.filter_by(difficulty=difficulty)
    routes = q.order_by(Route.created_at.desc()).all()
    return render_template('routes.html', routes=routes, filter_difficulty=difficulty)


@app.route('/routes/<int:route_id>')
@login_required
def route_detail(route_id):
    user = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    logs = HikeLog.query.filter_by(route_id=route_id, user_id=user.id)\
        .order_by(HikeLog.date.desc()).all()
    return render_template('route_detail.html', route=route, logs=logs)


@app.route('/navigate/<int:route_id>')
@login_required
def navigate(route_id):
    user = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    return render_template('navigate.html', route=route)


@app.route('/profile')
@login_required
def profile():
    user = current_user()
    logs = HikeLog.query.filter_by(user_id=user.id).order_by(HikeLog.date.desc()).all()
    return render_template('profile.html', logs=logs)


# ── JSON API ───────────────────────────────────────────────────────────────

@app.route('/api/routes', methods=['POST'])
@login_required
def api_create_route():
    user = current_user()
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400

    def _flt(key, default=None):
        v = data.get(key)
        try: return round(float(v), 2) if v is not None else default
        except (TypeError, ValueError): return default

    def _int(key, default=0):
        v = data.get(key)
        try: return int(v) if v is not None else default
        except (TypeError, ValueError): return default

    route = Route(
        user_id=user.id,
        name=data.get('name', '').strip() or 'Percorso senza nome',
        description=data.get('description', '').strip(),
        difficulty=data.get('difficulty', 'medium'),
        trail_type=data.get('trail_type', 'E'),
        route_type_tag=data.get('route_type_tag', 'punto_punto'),
        surface=data.get('surface', 'sentiero'),
        ferrata_grade=data.get('ferrata_grade') or None,
        hazards_json=json.dumps(data.get('hazards', [])),
        distance_km=_flt('distance_km', 0.0),
        elevation_gain_m=_int('elevation_gain_m'),
        elevation_loss_m=_int('elevation_loss_m'),
        max_elevation_m=_int('max_elevation_m') or None,
        min_elevation_m=_int('min_elevation_m') or None,
        duration_min=_flt('duration_min', 0.0),
        avg_slope_pct=_flt('avg_slope_pct'),
        max_slope_asc_pct=_flt('max_slope_asc_pct'),
        max_slope_desc_pct=_flt('max_slope_desc_pct'),
        waypoints_json=json.dumps(data.get('waypoints', [])),
        geometry_json=json.dumps(data.get('geometry')) if data.get('geometry') else None,
    )
    db.session.add(route)
    db.session.commit()
    return jsonify({'id': route.id, 'message': 'Percorso salvato'}), 201


@app.route('/api/routes/<int:route_id>', methods=['GET'])
@login_required
def api_get_route(route_id):
    user = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    return jsonify(route.to_dict())


@app.route('/api/routes/<int:route_id>', methods=['PUT'])
@login_required
def api_update_route(route_id):
    user  = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    data  = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400

    def _flt(key, default=None):
        v = data.get(key)
        try: return round(float(v), 2) if v is not None else default
        except (TypeError, ValueError): return default

    def _int(key, default=0):
        v = data.get(key)
        try: return int(v) if v is not None else default
        except (TypeError, ValueError): return default

    route.name             = data.get('name', '').strip() or route.name
    route.description      = data.get('description', '').strip()
    route.difficulty       = data.get('difficulty', route.difficulty)
    route.trail_type       = data.get('trail_type', route.trail_type)
    route.route_type_tag   = data.get('route_type_tag', route.route_type_tag)
    route.surface          = data.get('surface', route.surface)
    route.ferrata_grade    = data.get('ferrata_grade') or None
    route.hazards_json     = json.dumps(data.get('hazards', []))
    route.distance_km      = _flt('distance_km', route.distance_km)
    route.elevation_gain_m = _int('elevation_gain_m')
    route.elevation_loss_m = _int('elevation_loss_m')
    route.max_elevation_m  = _int('max_elevation_m') or None
    route.min_elevation_m  = _int('min_elevation_m') or None
    route.duration_min     = _flt('duration_min', route.duration_min)
    route.avg_slope_pct    = _flt('avg_slope_pct')
    route.max_slope_asc_pct  = _flt('max_slope_asc_pct')
    route.max_slope_desc_pct = _flt('max_slope_desc_pct')
    route.waypoints_json   = json.dumps(data.get('waypoints', []))
    if data.get('geometry'):
        route.geometry_json = json.dumps(data['geometry'])
    db.session.commit()
    return jsonify({'id': route.id, 'message': 'Percorso aggiornato'})


@app.route('/api/routes/<int:route_id>', methods=['DELETE'])
@login_required
def api_delete_route(route_id):
    user = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    db.session.delete(route)
    db.session.commit()
    return jsonify({'message': 'Eliminato'})


@app.route('/routes/<int:route_id>/log', methods=['POST'])
@login_required
def add_log(route_id):
    user = current_user()
    Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    try:
        date = datetime.strptime(request.form['date'], '%Y-%m-%d').date()
    except (KeyError, ValueError):
        date = datetime.utcnow().date()
    log = HikeLog(
        user_id=user.id,
        route_id=route_id,
        date=date,
        duration_min=request.form.get('duration_min', type=int),
        notes=request.form.get('notes', '').strip(),
        rating=request.form.get('rating', type=int),
    )
    db.session.add(log)
    db.session.commit()
    flash('Escursione registrata!', 'success')
    return redirect(url_for('route_detail', route_id=route_id))


@app.route('/routes/<int:route_id>/delete', methods=['POST'])
@login_required
def delete_route(route_id):
    user = current_user()
    route = Route.query.filter_by(id=route_id, user_id=user.id).first_or_404()
    db.session.delete(route)
    db.session.commit()
    flash('Percorso eliminato.', 'success')
    return redirect(url_for('routes_list'))


@app.route('/static/sw.js')
def sw():
    return send_from_directory('static', 'sw.js', mimetype='application/javascript')


with app.app_context():
    init_db()


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
