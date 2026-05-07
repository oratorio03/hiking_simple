from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from functools import wraps
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///predictsport.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)


# ── Models ─────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    predictions = db.relationship('Prediction', backref='user', lazy=True)
    comments = db.relationship('Comment', backref='user', lazy=True)
    notifications = db.relationship('Notification', backref='user', lazy=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    @property
    def predictions_count(self):
        return len(self.predictions)

    @property
    def accuracy(self):
        resolved = [p for p in self.predictions if p.result is not None]
        if not resolved:
            return 0.0
        correct = sum(1 for p in resolved if p.result == 'correct')
        return round((correct / len(resolved)) * 100, 1)

    @property
    def success_streak(self):
        sorted_preds = sorted(
            [p for p in self.predictions if p.result is not None],
            key=lambda p: p.created_at,
            reverse=True
        )
        streak = 0
        for p in sorted_preds:
            if p.result == 'correct':
                streak += 1
            else:
                break
        return streak

    @property
    def ranking(self):
        ranked = sorted(User.query.all(), key=lambda u: u.accuracy, reverse=True)
        for i, u in enumerate(ranked):
            if u.id == self.id:
                return i + 1
        return len(ranked)


class Prediction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    match = db.Column(db.String(200), nullable=False)
    prediction_text = db.Column(db.String(500), nullable=False)
    result = db.Column(db.String(20), nullable=True)  # 'correct', 'wrong', None
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def time_ago(self):
        return _time_ago(self.created_at)


class Comment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    likes = db.relationship('CommentLike', backref='comment', lazy=True, cascade='all, delete-orphan')

    @property
    def likes_count(self):
        return len(self.likes)

    def is_liked_by(self, user_id):
        return any(like.user_id == user_id for like in self.likes)

    def time_ago(self):
        return _time_ago(self.created_at)


class CommentLike(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    comment_id = db.Column(db.Integer, db.ForeignKey('comment.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    __table_args__ = (db.UniqueConstraint('comment_id', 'user_id', name='unique_comment_like'),)


class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    type = db.Column(db.String(20), nullable=False)  # 'prediction', 'social', 'achievement'
    title = db.Column(db.String(200), nullable=False)
    message = db.Column(db.Text, nullable=False)
    read = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def time_ago(self):
        return _time_ago(self.created_at)


# ── Helpers ────────────────────────────────────────────────────────────────

def _time_ago(dt):
    delta = datetime.utcnow() - dt
    total_seconds = int(delta.total_seconds())
    if total_seconds < 60:
        return f"{total_seconds}s fa"
    if total_seconds < 3600:
        return f"{total_seconds // 60}m fa"
    if total_seconds < 86400:
        return f"{total_seconds // 3600}h fa"
    return f"{delta.days}g fa"


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def current_user():
    if 'user_id' in session:
        return db.session.get(User, session['user_id'])
    return None


@app.context_processor
def inject_globals():
    user = current_user()
    unread = 0
    if user:
        unread = Notification.query.filter_by(user_id=user.id, read=False).count()
    return {'current_user': user, 'unread_notifications': unread}


# ── Auth routes ────────────────────────────────────────────────────────────

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
        if not username or not email or not password:
            flash('Tutti i campi sono obbligatori.', 'error')
        elif User.query.filter_by(username=username).first():
            flash('Username già in uso.', 'error')
        elif User.query.filter_by(email=email).first():
            flash('Email già in uso.', 'error')
        elif len(password) < 6:
            flash('La password deve avere almeno 6 caratteri.', 'error')
        else:
            user = User(username=username, email=email)
            user.set_password(password)
            db.session.add(user)
            db.session.flush()
            db.session.add(Notification(
                user_id=user.id, type='achievement',
                title='Benvenuto!',
                message=f'Ciao {username}! Inizia subito la tua prima predizione.'
            ))
            db.session.commit()
            session['user_id'] = user.id
            return redirect(url_for('index'))
    return render_template('auth/register.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ── Main routes ────────────────────────────────────────────────────────────

@app.route('/')
@login_required
def index():
    user = current_user()
    recent = Prediction.query.filter_by(user_id=user.id)\
        .order_by(Prediction.created_at.desc()).limit(5).all()
    top_users = sorted(User.query.all(), key=lambda u: u.accuracy, reverse=True)[:5]
    total_predictions = Prediction.query.count()
    total_users = User.query.count()
    return render_template('index.html', recent=recent, top_users=top_users,
                           total_predictions=total_predictions, total_users=total_users)


# ── Social routes ──────────────────────────────────────────────────────────

@app.route('/social')
@login_required
def social():
    tab = request.args.get('tab', 'ranking')
    top_users = sorted(User.query.all(), key=lambda u: u.accuracy, reverse=True)[:20]
    comments = Comment.query.order_by(Comment.created_at.desc()).all()
    user = current_user()
    return render_template('social.html', tab=tab, top_users=top_users,
                           comments=comments, user=user)


@app.route('/social/comment', methods=['POST'])
@login_required
def add_comment():
    user = current_user()
    content = request.form.get('content', '').strip()
    if content:
        db.session.add(Comment(user_id=user.id, content=content))
        db.session.commit()
    return redirect(url_for('social', tab='discussion'))


@app.route('/social/comment/<int:comment_id>/like', methods=['POST'])
@login_required
def toggle_like(comment_id):
    user = current_user()
    comment = db.session.get(Comment, comment_id)
    if not comment:
        return jsonify({'error': 'not found'}), 404
    existing = CommentLike.query.filter_by(comment_id=comment_id, user_id=user.id).first()
    if existing:
        db.session.delete(existing)
        liked = False
    else:
        db.session.add(CommentLike(comment_id=comment_id, user_id=user.id))
        liked = True
    db.session.commit()
    return jsonify({'likes': comment.likes_count, 'liked': liked})


# ── Notification routes ────────────────────────────────────────────────────

@app.route('/notifications')
@login_required
def notifications():
    user = current_user()
    filter_type = request.args.get('filter', 'all')
    query = Notification.query.filter_by(user_id=user.id).order_by(Notification.created_at.desc())
    if filter_type == 'unread':
        query = query.filter_by(read=False)
    notifs = query.all()
    unread_count = Notification.query.filter_by(user_id=user.id, read=False).count()
    return render_template('notifications.html', notifications=notifs,
                           unread_count=unread_count, filter=filter_type)


@app.route('/notifications/<int:notif_id>/read', methods=['POST'])
@login_required
def mark_read(notif_id):
    user = current_user()
    notif = Notification.query.filter_by(id=notif_id, user_id=user.id).first_or_404()
    notif.read = True
    db.session.commit()
    return jsonify({'success': True})


@app.route('/notifications/read-all', methods=['POST'])
@login_required
def mark_all_read():
    user = current_user()
    Notification.query.filter_by(user_id=user.id, read=False).update({'read': True})
    db.session.commit()
    return redirect(url_for('notifications'))


# ── Prediction routes ──────────────────────────────────────────────────────

@app.route('/predictions')
@login_required
def predictions():
    user = current_user()
    user_preds = Prediction.query.filter_by(user_id=user.id)\
        .order_by(Prediction.created_at.desc()).all()
    return render_template('predictions.html', predictions=user_preds)


@app.route('/predictions/new', methods=['GET', 'POST'])
@login_required
def new_prediction():
    user = current_user()
    if request.method == 'POST':
        match = request.form.get('match', '').strip()
        prediction_text = request.form.get('prediction_text', '').strip()
        if match and prediction_text:
            db.session.add(Prediction(user_id=user.id, match=match, prediction_text=prediction_text))
            db.session.commit()
            flash('Predizione aggiunta con successo!', 'success')
            return redirect(url_for('predictions'))
        flash('Compila tutti i campi.', 'error')
    return render_template('new_prediction.html')


@app.route('/predictions/<int:pred_id>/result', methods=['POST'])
@login_required
def set_result(pred_id):
    user = current_user()
    pred = Prediction.query.filter_by(id=pred_id, user_id=user.id).first_or_404()
    result = request.form.get('result')
    if result not in ('correct', 'wrong'):
        flash('Risultato non valido.', 'error')
        return redirect(url_for('predictions'))

    pred.result = result
    db.session.flush()

    label = 'Corretta!' if result == 'correct' else 'Sbagliata'
    db.session.add(Notification(
        user_id=user.id, type='prediction',
        title=f'Predizione {label}',
        message=f'"{pred.match}" — la tua predizione era {"corretta ✓" if result == "correct" else "sbagliata ✗"}'
    ))

    # Achievement: 5 consecutive correct
    if result == 'correct' and user.success_streak >= 5:
        already = Notification.query.filter_by(
            user_id=user.id, type='achievement', title='5 in fila!'
        ).count()
        if not already:
            db.session.add(Notification(
                user_id=user.id, type='achievement',
                title='5 in fila!',
                message='Complimenti! Hai raggiunto 5 predizioni corrette consecutive!'
            ))

    db.session.commit()
    return redirect(url_for('predictions'))


@app.route('/predictions/<int:pred_id>/delete', methods=['POST'])
@login_required
def delete_prediction(pred_id):
    user = current_user()
    pred = Prediction.query.filter_by(id=pred_id, user_id=user.id).first_or_404()
    db.session.delete(pred)
    db.session.commit()
    flash('Predizione eliminata.', 'success')
    return redirect(url_for('predictions'))


# ── Profile routes ─────────────────────────────────────────────────────────

@app.route('/profile')
@login_required
def profile():
    user = current_user()
    return render_template('profile.html', profile_user=user)


@app.route('/profile/<int:user_id>')
@login_required
def user_profile(user_id):
    profile_user = db.session.get(User, user_id) or \
        (_ for _ in ()).throw(Exception('not found'))
    return render_template('profile.html', profile_user=profile_user)


# ── Seed demo data ─────────────────────────────────────────────────────────

def seed_demo_data():
    if User.query.count() > 0:
        return

    demo_users = [
        ('ProPredictor', 'pro@example.com', 'demo1234'),
        ('BettingKing', 'king@example.com', 'demo1234'),
        ('StatisticsMaster', 'stats@example.com', 'demo1234'),
        ('PredictorPro', 'predpro@example.com', 'demo1234'),
    ]
    users = []
    for username, email, pw in demo_users:
        u = User(username=username, email=email)
        u.set_password(pw)
        db.session.add(u)
        users.append(u)
    db.session.flush()

    pred_data = [
        (users[0], 'Man City - Arsenal', '2-1 City', 'correct'),
        (users[0], 'Barcelona - Real Madrid', 'Over 2.5', 'correct'),
        (users[0], 'Juventus - Napoli', '1-0 Juve', 'correct'),
        (users[0], 'PSG - Lyon', 'Over 2.5', 'correct'),
        (users[0], 'Inter - Milan', 'BTTS', 'correct'),
        (users[1], 'Liverpool - Chelsea', '2-0 Liverpool', 'correct'),
        (users[1], 'Atletico - Sevilla', '1-0 Atletico', 'wrong'),
        (users[1], 'Bayern - Dortmund', 'Over 2.5', 'correct'),
        (users[2], 'Roma - Lazio', 'BTTS', 'correct'),
        (users[2], 'Fiorentina - Milan', 'X', 'wrong'),
        (users[3], 'Atalanta - Napoli', '2-1 Atalanta', 'wrong'),
    ]
    for u, match, text, res in pred_data:
        db.session.add(Prediction(user_id=u.id, match=match, prediction_text=text, result=res))

    comment_data = [
        (users[0], "Il City ha un trend positivo nelle ultime 5 partite casalinghe contro l'Arsenal"),
        (users[1], "Attenzione all'Over, entrambe le squadre hanno segnato negli ultimi 4 scontri diretti"),
        (users[2], "Le statistiche mostrano che il 70% degli scontri diretti termina con almeno 3 gol"),
    ]
    comments = []
    for u, content in comment_data:
        c = Comment(user_id=u.id, content=content)
        db.session.add(c)
        comments.append(c)
    db.session.flush()

    db.session.add_all([
        CommentLike(comment_id=comments[0].id, user_id=users[1].id),
        CommentLike(comment_id=comments[0].id, user_id=users[2].id),
        CommentLike(comment_id=comments[1].id, user_id=users[0].id),
    ])

    db.session.add_all([
        Notification(user_id=users[0].id, type='prediction', title='Predizione Corretta!',
                     message='La tua predizione Man City - Arsenal (2-1) era corretta', read=False),
        Notification(user_id=users[0].id, type='social', title='Nuovo Commento',
                     message='BettingKing ha risposto alla tua analisi', read=False),
        Notification(user_id=users[0].id, type='achievement', title='5 in fila!',
                     message='Hai raggiunto 5 predizioni corrette consecutive!', read=True),
    ])
    db.session.commit()


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        seed_demo_data()
    app.run(debug=True, port=5000)
