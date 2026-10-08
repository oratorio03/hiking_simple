from flask import Flask, Response, render_template, request, redirect, url_for, session, jsonify, flash, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from datetime import datetime
from functools import wraps
import json
import math
import os
import re
import unicodedata
import xml.etree.ElementTree as ET

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
    'asfalto':   'Asfalto / cemento',
    'lastricato':'Lastricato / acciottolato',
    'ghiaia':    'Ghiaia / sterrato fine',
    'terra':     'Terra battuta',
    'sentiero':  'Sentiero (irregolare / radici)',
    'sterrato':  'Sterrato / mulattiera',
    'roccioso':  'Roccioso / massi',
    'neve':      'Neve / ghiacciaio',
    'misto':     'Misto',
}

HAZARD_META = {
    # Terrain hazards
    'esposto':   ('bi-exclamation-triangle-fill', 'warning',   'Tratti esposti'),
    'ferrata':   ('bi-ladder',                    'danger',    'Via ferrata'),
    'tecnico':   ('bi-tools',                     'secondary', 'Terreno tecnico'),
    'roccia':    ('bi-triangle-fill',             'secondary', 'Roccia'),
    # Terrain surface hazards
    'radici':    ('bi-tree-fill',                 'warning',   'Radici / terreno irregolare'),
    'gradini':   ('bi-arrow-up-square-fill',      'secondary', 'Gradini / scalini'),
    'fango':     ('bi-droplet-half',              'secondary', 'Fango / terreno molle'),
    'instabile': ('bi-exclamation-diamond-fill',  'danger',    'Fondo instabile'),
    # Weather/alpine hazards
    'neve':      ('bi-snow2',                     'primary',   'Neve'),
    'ghiaccio':  ('bi-thermometer-snow',          'info',      'Ghiaccio'),
    'valanghe':  ('bi-cloud-snow-fill',           'danger',    'Rischio valanghe'),
    'fiume':     ('bi-water',                     'primary',   'Guado / fiume'),
}


# ── Category rules ─────────────────────────────────────────────────────────
# Pure data: the /routes box text is generated from it by describe_category() so it cannot drift
# from route_fails_category(). None means "no limit".

FERRATA_GRADES = ('F', 'PD', 'AD', 'D', 'TD', 'ED')

SURFACE_SHORT_LABELS = {
    'asfalto':    'asfalto',
    'lastricato': 'lastricato',
    'ghiaia':     'ghiaia',
    'terra':      'terra battuta',
    'sentiero':   'sentiero irregolare',
    'sterrato':   'sterrato',
    'roccioso':   'roccia / massi',
    'neve':       'neve / ghiacciaio',
    'misto':      'misto',
}

# Smooth, stable surfaces with no loose material (strollers, wheelchairs)
ACCESSIBLE_SURFACES = {'asfalto', 'lastricato', 'ghiaia'}
STABLE_SURFACES = ACCESSIBLE_SURFACES | {'terra', 'sterrato'}
EASY_DIFFICULTIES = {'easy', 'medium'}

CATEGORY_RULES = {
    'passeggino': {
        'label': 'Passeggino / Carrozzina',
        'icon':  'bi-person-wheelchair',
        'color': 'info',
        'desc':  'Percorsi T quasi pianeggianti (pendenza max 6%) su asfalto, lastricato o ghiaia, '
                 'livello facile o medio, senza ostacoli: adatti a passeggini e sedie a rotelle',
        'max_avg_slope':        6,
        'max_slope_asc':        6,
        'max_slope_desc':       6,
        'require_slope_data':   True,
        'allowed_trail_types':  {'T'},
        'allowed_surfaces':     ACCESSIBLE_SURFACES,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    {'esposto', 'tecnico', 'roccia', 'radici', 'gradini', 'fango',
                                 'instabile', 'neve', 'ghiaccio', 'valanghe', 'fiume'},
        'allowed_difficulties': EASY_DIFFICULTIES,
        'allow_ferrata':        False,
        'max_ferrata_grade':    None,
        'notes':                [],
    },
    'famiglia': {
        'label': 'Famiglie / Principianti',
        'icon':  'bi-people-fill',
        'color': 'success',
        'desc':  'Per famiglie con bambini e principianti: percorsi T o E di livello facile o medio, '
                 'pendenza max 10%, senza ostacoli, neve o guadi',
        'max_avg_slope':        10,
        'max_slope_asc':        10,
        'max_slope_desc':       10,
        'require_slope_data':   True,
        'allowed_trail_types':  {'T', 'E'},
        'allowed_surfaces':     STABLE_SURFACES,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    {'esposto', 'tecnico', 'roccia', 'radici', 'gradini',
                                 'instabile', 'neve', 'ghiaccio', 'valanghe', 'fiume'},
        'allowed_difficulties': EASY_DIFFICULTIES,
        'allow_ferrata':        False,
        'max_ferrata_grade':    None,
        'notes':                [],
    },
    'anziani': {
        'label': 'Anziani / Mobilità ridotta',
        'icon':  'bi-heart-pulse-fill',
        'color': 'secondary',
        'desc':  'Terreno stabile e regolare: percorsi T o E di livello facile o medio, '
                 'pendenza max 15%, senza ostacoli, fango, neve o guadi',
        'max_avg_slope':        15,
        'max_slope_asc':        15,
        'max_slope_desc':       15,
        'require_slope_data':   True,
        'allowed_trail_types':  {'T', 'E'},
        'allowed_surfaces':     STABLE_SURFACES,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    {'esposto', 'tecnico', 'roccia', 'radici', 'gradini', 'fango',
                                 'instabile', 'neve', 'ghiaccio', 'valanghe', 'fiume'},
        'allowed_difficulties': EASY_DIFFICULTIES,
        'allow_ferrata':        False,
        'max_ferrata_grade':    None,
        'notes':                [],
    },
    'escursionista': {
        'label': 'Escursionista',
        'icon':  'bi-person-walking',
        'color': 'primary',
        'desc':  'Percorsi T, E o EE con pendenza max 25%: terreno vario e tratti esposti ammessi, '
                 'nessuna ferrata',
        'max_avg_slope':        25,
        'max_slope_asc':        25,
        'max_slope_desc':       25,
        'require_slope_data':   False,
        'allowed_trail_types':  {'T', 'E', 'EE'},
        'allowed_surfaces':     None,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    set(),
        'allowed_difficulties': None,
        'allow_ferrata':        False,
        'max_ferrata_grade':    None,
        'notes': ['Tratti esposti ammessi',
                  'Radici e terreno irregolare ammessi',
                  'Neve / ghiaccio: valutare le condizioni'],
    },
    'sportivo': {
        'label': 'Sportivo / EE+',
        'icon':  'bi-activity',
        'color': 'warning',
        'desc':  'Percorsi fino a EE, EEA, F e PD con pendenza max 30%; '
                 'ferrate solo con grado indicato fino a PD, nessun grado alpino AD o superiore',
        'max_avg_slope':        30,
        'max_slope_asc':        30,
        'max_slope_desc':       30,
        'require_slope_data':   False,
        'allowed_trail_types':  {'T', 'E', 'EE', 'EEA', 'F', 'PD'},
        'allowed_surfaces':     None,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    set(),
        'allowed_difficulties': None,
        'allow_ferrata':        True,
        'max_ferrata_grade':    'PD',
        'notes': ['Tratti esposti e terreno tecnico ammessi',
                  'Neve / ghiaccio: valutare le condizioni'],
    },
    'esperto': {
        'label': 'Esperto / Alpinista',
        'icon':  'bi-trophy-fill',
        'color': 'danger',
        'desc':  'Nessun limite: ferrate, alta quota e gradi alpini inclusi',
        'max_avg_slope':        None,
        'max_slope_asc':        None,
        'max_slope_desc':       None,
        'require_slope_data':   False,
        'allowed_trail_types':  None,
        'allowed_surfaces':     None,
        'forbidden_surfaces':   set(),
        'forbidden_hazards':    set(),
        'allowed_difficulties': None,
        'allow_ferrata':        True,
        'max_ferrata_grade':    None,
        'notes': ['Nessun limite: ferrate, alta quota e gradi alpini inclusi',
                  'Qualsiasi pendenza e tipo di fondo'],
    },
}


def _join_or(items):
    items = list(items)
    return ', '.join(items[:-1]) + ' o ' + items[-1] if len(items) > 1 else items[0]


def _in_order(keys, reference):
    return [k for k in reference if k in keys]


def describe_category(rules):
    rule_text, lines = {}, []

    def add(check, text, icon='check-circle', color='success'):
        rule_text[check] = text
        if (icon, color, text) not in lines:
            lines.append((icon, color, text))

    if rules['allowed_trail_types'] is not None:
        grades = _in_order(rules['allowed_trail_types'], TRAIL_TYPE_LABELS)
        add('trail_type', 'Scala CAI: ' + (f'solo {grades[0]}' if len(grades) == 1 else _join_or(grades)))
    if rules['max_avg_slope'] is not None:
        add('avg_slope', f"Pendenza media max {rules['max_avg_slope']}%")
    asc, desc = rules['max_slope_asc'], rules['max_slope_desc']
    if asc is not None and asc == desc:
        add('slope_asc', f'Pendenza max salita/discesa {asc}%')
        add('slope_desc', f'Pendenza max salita/discesa {desc}%')
    else:
        if asc is not None:
            add('slope_asc', f'Pendenza max salita {asc}%')
        if desc is not None:
            add('slope_desc', f'Pendenza max discesa {desc}%')
    if rules['require_slope_data']:
        add('slope_data', 'Solo percorsi con pendenza misurata')
    if rules['allowed_surfaces'] is not None:
        names = [SURFACE_SHORT_LABELS[s] for s in _in_order(rules['allowed_surfaces'], SURFACE_LABELS)]
        add('surface', 'Fondo: ' + _join_or(names))
    if rules['forbidden_surfaces']:
        names = [SURFACE_SHORT_LABELS[s] for s in _in_order(rules['forbidden_surfaces'], SURFACE_LABELS)]
        add('forbidden_surface', 'Fondo escluso: ' + _join_or(names), 'x-circle', 'danger')
    if rules['allowed_difficulties'] is not None:
        names = [DIFFICULTY_LABELS[d] for d in _in_order(rules['allowed_difficulties'], DIFFICULTY_LABELS)]
        add('difficulty', 'Livello: ' + _join_or(names))
    if not rules['allow_ferrata']:
        add('ferrata', 'Nessuna ferrata', 'x-circle', 'danger')
    elif rules['max_ferrata_grade']:
        add('ferrata', f"Ferrate solo con grado indicato, fino a {rules['max_ferrata_grade']}")
    lines += [('check-circle', 'warning', note) for note in rules['notes']]
    return {
        'rule_text': rule_text,
        'rules_detail': lines,
        'forbidden_hazard_meta': [(key, *meta) for key, meta in HAZARD_META.items()
                                  if key in rules['forbidden_hazards']],
    }


for _rules in CATEGORY_RULES.values():
    _rules.update(describe_category(_rules))


# ── Per-view overrides ─────────────────────────────────────────────────────
# Query-string switches layered on a category preset: each is include|exclude, absent = preset.
# effective_rules() builds the rules both the filter and the displayed box are generated from.

OVERRIDE_MODES = {'include', 'exclude'}
FERRATA_INTRINSIC_HAZARDS = {'esposto', 'roccia', 'tecnico'}
PEND_VALUES = (6, 8, 10, 12, 15, 20, 25, 30, 40)

OVERRIDE_SWITCHES = (
    {'key': 'ferrate', 'kind': 'ferrata', 'label': 'Ferrate', 'icon': 'bi-ladder',
     'options': ('Includi', 'Escludi'),
     'note': 'Ferrate incluse (restano i limiti di pendenza)'},
    {'key': 'esposti', 'kind': 'hazards', 'label': 'Tratti esposti', 'icon': 'bi-exclamation-triangle',
     'hazards': ('esposto',), 'options': ('Ammetti', 'Escludi'),
     'allow': 'Tratti esposti ammessi', 'deny': 'Nessun tratto esposto'},
    {'key': 'roccia', 'kind': 'hazards', 'label': 'Roccia / tecnico', 'icon': 'bi-triangle',
     'hazards': ('roccia', 'tecnico'), 'options': ('Ammetti', 'Escludi'),
     'allow': 'Roccia e terreno tecnico ammessi', 'deny': 'Nessuna roccia o terreno tecnico'},
    {'key': 'neve', 'kind': 'hazards', 'label': 'Neve / ghiaccio', 'icon': 'bi-snow2',
     'hazards': ('neve', 'ghiaccio', 'valanghe'), 'options': ('Ammetti', 'Escludi'),
     'allow': 'Neve, ghiaccio e valanghe ammessi', 'deny': 'Nessuna neve, ghiaccio o valanga'},
    {'key': 'terreno', 'kind': 'hazards', 'label': 'Terreno irregolare', 'icon': 'bi-tree',
     'hazards': ('radici', 'gradini', 'fango', 'instabile'), 'options': ('Ammetti', 'Escludi'),
     'allow': 'Terreno irregolare ammesso', 'deny': 'Nessun terreno irregolare'},
    {'key': 'guadi', 'kind': 'hazards', 'label': 'Guadi', 'icon': 'bi-water',
     'hazards': ('fiume',), 'options': ('Ammetti', 'Escludi'),
     'allow': 'Guadi ammessi', 'deny': 'Nessun guado'},
    {'key': 'fondo', 'kind': 'surface', 'label': 'Fondo', 'icon': 'bi-layers',
     'options': ('Fondo: qualsiasi', 'Solo fondo stabile'), 'note': 'Fondo: qualsiasi'},
    {'key': 'dati', 'kind': 'slope_data', 'label': 'Pendenza non misurata', 'icon': 'bi-rulers',
     'options': ('Ammetti senza dati', 'Richiedi dati'), 'note': 'Percorsi senza dati di pendenza ammessi'},
)
PEND_SWITCH = {'key': 'pend', 'label': 'Pendenza massima', 'icon': 'bi-graph-up-arrow'}
OVERRIDE_KEYS = {sw['key'] for sw in OVERRIDE_SWITCHES} | {'pend'}

# Preset notes that an override would contradict (dropped when that switch is set at all).
_ALL_OVERRIDES = OVERRIDE_KEYS
NOTE_CONFLICTS = {
    'Tratti esposti ammessi': {'esposti'},
    'Radici e terreno irregolare ammessi': {'terreno'},
    'Neve / ghiaccio: valutare le condizioni': {'neve'},
    'Tratti esposti e terreno tecnico ammessi': {'esposti', 'roccia'},
    'Nessun limite: ferrate, alta quota e gradi alpini inclusi': _ALL_OVERRIDES - {'dati'},
    'Qualsiasi pendenza e tipo di fondo': {'pend', 'fondo'},
}
_DERIVED_RULE_KEYS = ('rule_text', 'rules_detail', 'forbidden_hazard_meta')


def parse_overrides(args):
    overrides = {sw['key']: args.get(sw['key']) for sw in OVERRIDE_SWITCHES if args.get(sw['key']) in OVERRIDE_MODES}
    pend = args.get('pend', type=int)
    if pend in PEND_VALUES:
        overrides['pend'] = pend
    return overrides


def _valid_overrides(overrides):
    if not overrides:
        return {}
    clean = {sw['key']: overrides[sw['key']] for sw in OVERRIDE_SWITCHES if overrides.get(sw['key']) in OVERRIDE_MODES}
    if overrides.get('pend') in PEND_VALUES:
        clean['pend'] = overrides['pend']
    return clean


def effective_rules(rules, overrides=None):
    """The category rules with the overrides applied, plus regenerated text and hazard pills."""
    overrides = _valid_overrides(overrides)
    if not overrides:
        return rules
    eff = {k: v for k, v in rules.items() if k not in _DERIVED_RULE_KEYS}
    eff['forbidden_hazards'] = set(rules['forbidden_hazards'])
    eff['forbidden_surfaces'] = set(rules['forbidden_surfaces'])
    notes = [n for n in rules['notes'] if not NOTE_CONFLICTS.get(n, set()) & overrides.keys()]
    for sw in OVERRIDE_SWITCHES:
        mode = overrides.get(sw['key'])
        if not mode:
            continue
        include = mode == 'include'
        if sw['kind'] == 'ferrata':
            eff['ferrata_mode'] = mode
            eff['allow_ferrata'] = include
            eff['max_ferrata_grade'] = None
            if include:
                notes.append(sw['note'])
        elif sw['kind'] == 'hazards':
            hazards = set(sw['hazards'])
            eff['forbidden_hazards'] = eff['forbidden_hazards'] - hazards if include else eff['forbidden_hazards'] | hazards
            notes.append(sw['allow'] if include else sw['deny'])
        elif sw['kind'] == 'surface':
            if include:
                eff['allowed_surfaces'] = None
                eff['forbidden_surfaces'] = set()
                notes.append(sw['note'])
            else:
                allowed = eff['allowed_surfaces']
                eff['allowed_surfaces'] = STABLE_SURFACES if allowed is None else set(allowed) & STABLE_SURFACES
        elif sw['kind'] == 'slope_data':
            eff['require_slope_data'] = not include
            if include:
                notes.append(sw['note'])
    if 'pend' in overrides:
        eff['max_avg_slope'] = eff['max_slope_asc'] = eff['max_slope_desc'] = overrides['pend']
    eff['notes'] = notes
    eff.update(describe_category(eff))
    return eff


def _fails(route, rules):
    text = rules['rule_text']
    ferrata_mode = rules.get('ferrata_mode')
    ferrata_included = ferrata_mode == 'include' and route.is_ferrata
    if ferrata_mode == 'exclude' and route.is_ferrata:
        return 'Nessuna ferrata'
    if (rules['allowed_trail_types'] is not None and route.trail_type not in rules['allowed_trail_types']
            and not (ferrata_included and route.trail_type == 'EEA')):
        return text['trail_type']
    slopes = {
        'avg_slope':  (route.avg_slope_pct, rules['max_avg_slope']),
        'slope_asc':  (route.max_slope_asc_pct, rules['max_slope_asc']),
        'slope_desc': (route.max_slope_desc_pct, rules['max_slope_desc']),
    }
    if rules['require_slope_data'] and any(value is None for value, _ in slopes.values()):
        return text['slope_data']
    for check, (value, limit) in slopes.items():
        # Descent is stored as a negative percentage.
        if limit is not None and value is not None and abs(value) > limit:
            return text[check]
    if not ferrata_included:
        if rules['allowed_surfaces'] is not None and route.surface not in rules['allowed_surfaces']:
            return text['surface']
        if route.surface in rules['forbidden_surfaces']:
            return text['forbidden_surface']
        if rules['allowed_difficulties'] is not None and route.difficulty not in rules['allowed_difficulties']:
            return text['difficulty']
    if route.is_ferrata and not ferrata_included:
        if not rules['allow_ferrata']:
            return text['ferrata']
        limit = rules['max_ferrata_grade']
        if limit and (route.ferrata_grade not in FERRATA_GRADES or
                      FERRATA_GRADES.index(route.ferrata_grade) > FERRATA_GRADES.index(limit)):
            return text['ferrata']
    hazards = set(route.hazards)
    if ferrata_included:
        hazards -= FERRATA_INTRINSIC_HAZARDS
    for key, _icon, _color, label in rules['forbidden_hazard_meta']:
        if key in hazards:
            return f'Attenzione segnalata: {label}'
    return None


def route_fails_category(route, rules, overrides=None):
    """Return the text of the first rule the route breaks, or None when it fits.

    overrides (see parse_overrides) adjust the preset. ferrate=exclude rejects every ferrata;
    ferrate=include accepts ferrate and exempts them from the CAI, surface, level and
    exposure/rock/technical rules that are inherent to a ferrata. Slope limits still apply.
    """
    return _fails(route, effective_rules(rules, overrides))


def apply_category_filter(routes, category, overrides=None):
    rules = CATEGORY_RULES.get(category)
    if not rules:
        return routes
    rules = effective_rules(rules, overrides)
    return [route for route in routes if _fails(route, rules) is None]


def override_controls(category, overrides):
    """View model for the "Personalizza" buttons: toggling one switch keeps the others."""
    def option(key, value, label):
        args = {k: v for k, v in overrides.items() if k != key}
        if value is not None:
            args[key] = value
        return {'label': label, 'active': overrides.get(key) == value, 'url': url_for('routes_list', category=category, **args)}

    controls = [{'key': sw['key'], 'label': sw['label'], 'icon': sw['icon'],
                 'options': [option(sw['key'], None, 'Come categoria'),
                             option(sw['key'], 'include', sw['options'][0]),
                             option(sw['key'], 'exclude', sw['options'][1])]}
                for sw in OVERRIDE_SWITCHES]
    controls.append({'key': 'pend', 'label': PEND_SWITCH['label'], 'icon': PEND_SWITCH['icon'],
                     'options': [option('pend', None, 'Come categoria')] +
                                [option('pend', value, f'{value}%') for value in PEND_VALUES]})
    return controls


def _is_ferrata(trail_type, hazards):
    return trail_type == 'EEA' or (isinstance(hazards, list) and 'ferrata' in hazards)


def _submitted_ferrata_grade(grade, trail_type, hazards):
    return grade if _is_ferrata(trail_type, hazards) and grade in FERRATA_GRADES else None


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
        hazards = json.loads(self.hazards_json or '[]')
        return [h for h in hazards if isinstance(h, str)] if isinstance(hazards, list) else []

    @property
    def is_ferrata(self):
        return _is_ferrata(self.trail_type, self.hazards)

    @property
    def difficulty_label(self):
        return DIFFICULTY_LABELS.get(self.difficulty, 'Non indicato')

    @property
    def difficulty_color(self):
        return DIFFICULTY_COLORS.get(self.difficulty, 'warning')

    @property
    def trail_type_label(self):
        return TRAIL_TYPE_LABELS.get(self.trail_type, self.trail_type or 'Scala CAI non indicata')

    @property
    def route_type_label(self):
        return ROUTE_TYPE_LABELS.get(self.route_type_tag, self.route_type_tag or '—')

    @property
    def surface_label(self):
        return SURFACE_LABELS.get(self.surface, self.surface or '—')

    @property
    def hazard_meta(self):
        return [(h, HAZARD_META[h]) for h in self.hazards if h in HAZARD_META]

    @property
    def start_point(self):
        return _point_dict(_route_track_points(self, limit=2) or _route_waypoint_points(self))

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


GPX_NS = 'http://www.topografix.com/GPX/1/1'
_XML_INVALID_CHARS = re.compile('[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]')


def _finite_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _valid_lat_lon(lat, lon):
    lat, lon = _finite_float(lat), _finite_float(lon)
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        return None
    return lat, lon


def _gpx_degrees(value):
    text = f'{value:.7f}'.rstrip('0').rstrip('.')
    return '0' if text == '-0' else text


def _gpx_text(parent, tag, text):
    el = ET.SubElement(parent, tag)
    el.text = _XML_INVALID_CHARS.sub('', str(text))
    return el


def _gpx_point(parent, tag, lat, lon):
    return ET.SubElement(parent, tag, lat=_gpx_degrees(lat), lon=_gpx_degrees(lon))


def _route_track_points(route, limit=None):
    try:
        geometry = json.loads(route.geometry_json) if route.geometry_json else None
    except ValueError:
        return []
    if not isinstance(geometry, dict) or geometry.get('type') != 'LineString':
        return []
    coords = geometry.get('coordinates')
    if not isinstance(coords, list):
        return []
    points = []
    for coord in coords:
        if not isinstance(coord, list) or len(coord) < 2:
            continue
        lat_lon = _valid_lat_lon(coord[1], coord[0])
        if lat_lon:
            ele = _finite_float(coord[2]) if len(coord) > 2 else None
            points.append((*lat_lon, ele))
            if len(points) == limit:
                break
    return points if len(points) >= 2 else []


def _route_waypoint_points(route):
    waypoints = route.waypoints
    if not isinstance(waypoints, list):
        return []
    points = []
    for wp in waypoints:
        if not isinstance(wp, dict):
            continue
        lat_lon = _valid_lat_lon(wp.get('lat'), wp.get('lng'))
        if lat_lon:
            points.append((*lat_lon, wp.get('name')))
    return points


def _point_dict(points):
    return {'lat': points[0][0], 'lng': points[0][1]} if points else None


def simplified_geometry(points, max_points=300):
    if len(points) < 2:
        return None
    max_points = max(max_points, 2)
    if len(points) > max_points:
        step = (len(points) - 1) / (max_points - 1)
        points = [points[round(i * step)] for i in range(max_points)]
    return {'type': 'LineString',
            'coordinates': [[round(p[1], 6), round(p[0], 6)] for p in points]}


def _haversine_km(lat1, lon1, lat2, lon2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((phi2 - phi1) / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(min(1.0, a)))


_APOSTROPHES = str.maketrans({'’': "'", '‘': "'", 'ʼ': "'", '`': "'"})


def _fold_text(text):
    decomposed = unicodedata.normalize('NFKD', (text or '').casefold().translate(_APOSTROPHES))
    return ''.join(c for c in decomposed if not unicodedata.combining(c))


def _route_matches_tokens(route, tokens):
    haystack = _fold_text(f'{route.name}\n{route.description or ""}')
    return all(token in haystack for token in tokens)


def _route_search_result(route, distance_km=None, track=None):
    if track is None:
        track = _route_track_points(route)
    description = route.description or ''
    if len(description) > 140:
        description = description[:139].rstrip() + '…'
    return {
        'id': route.id,
        'name': route.name,
        'description': description,
        'distance_km': route.distance_km,
        'elevation_gain_m': route.elevation_gain_m,
        'trail_type': route.trail_type,
        'difficulty': route.difficulty,
        'difficulty_label': route.difficulty_label,
        'start': _point_dict(track or _route_waypoint_points(route)),
        'distance_from_point_km': round(distance_km, 3) if distance_km is not None else None,
        'geometry': simplified_geometry(track),
        'url': url_for('route_detail', route_id=route.id),
        'edit_url': url_for('map_view', route_id=route.id),
    }


def build_route_gpx(route):
    root = ET.Element('gpx', {'version': '1.1', 'creator': 'HikePath', 'xmlns': GPX_NS})
    metadata = ET.SubElement(root, 'metadata')
    _gpx_text(metadata, 'name', route.name)
    if route.description:
        _gpx_text(metadata, 'desc', route.description)
    if route.created_at:
        _gpx_text(metadata, 'time', route.created_at.strftime('%Y-%m-%dT%H:%M:%SZ'))

    waypoints = _route_waypoint_points(route)
    for lat, lon, name in waypoints:
        wpt = _gpx_point(root, 'wpt', lat, lon)
        if name:
            _gpx_text(wpt, 'name', name)

    track = _route_track_points(route)
    if track:
        trk = ET.SubElement(root, 'trk')
        _gpx_text(trk, 'name', route.name)
        trkseg = ET.SubElement(trk, 'trkseg')
        for lat, lon, ele in track:
            trkpt = _gpx_point(trkseg, 'trkpt', lat, lon)
            if ele is not None:
                _gpx_text(trkpt, 'ele', f'{ele:.1f}')
    elif waypoints:
        rte = ET.SubElement(root, 'rte')
        _gpx_text(rte, 'name', route.name)
        for lat, lon, name in waypoints:
            rtept = _gpx_point(rte, 'rtept', lat, lon)
            if name:
                _gpx_text(rtept, 'name', name)

    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


@app.context_processor
def inject_user():
    return {
        'current_user': current_user(),
        'now': datetime.utcnow(),
        'HAZARD_META': HAZARD_META,
        'TRAIL_TYPE_LABELS': TRAIL_TYPE_LABELS,
        'CATEGORY_RULES': CATEGORY_RULES,
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
    category = request.args.get('category', '')
    all_routes = Route.query.filter_by(user_id=user.id).order_by(Route.created_at.desc()).all()
    overrides = parse_overrides(request.args)
    routes = apply_category_filter(all_routes, category, overrides)
    rules = CATEGORY_RULES.get(category)
    return render_template('routes.html', routes=routes,
                           filter_category=category,
                           overrides=overrides,
                           hazard_meta=effective_rules(rules, overrides)['forbidden_hazard_meta'] if rules else [],
                           override_controls=override_controls(category, overrides) if rules else [],
                           rules_detail=effective_rules(rules, overrides)['rules_detail'] if rules else [],
                           total_routes=len(all_routes))


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

    trail_type = data.get('trail_type', 'E')
    hazards = data.get('hazards', [])
    route = Route(
        user_id=user.id,
        name=data.get('name', '').strip() or 'Percorso senza nome',
        description=data.get('description', '').strip(),
        difficulty=data.get('difficulty', 'medium'),
        trail_type=trail_type,
        route_type_tag=data.get('route_type_tag', 'punto_punto'),
        surface=data.get('surface', 'sentiero'),
        ferrata_grade=_submitted_ferrata_grade(data.get('ferrata_grade'), trail_type, hazards),
        hazards_json=json.dumps(hazards),
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


@app.route('/api/routes/search')
@login_required
def api_search_routes():
    args = request.args
    q = (args.get('q') or '').strip()[:100]
    point = None
    if 'lat' in args or 'lng' in args:
        point = _valid_lat_lon(args.get('lat'), args.get('lng'))
        if point is None:
            return jsonify({'error': 'Parametri lat e lng mancanti o non validi.'}), 400
    radius_km = _finite_float(args.get('radius_km'))
    radius_km = 25.0 if radius_km is None else min(max(radius_km, 1.0), 200.0)
    limit = args.get('limit', type=int)
    limit = 20 if limit is None else min(max(limit, 1), 50)

    routes = Route.query.filter_by(user_id=current_user().id)\
        .order_by(Route.created_at.desc(), Route.id.desc()).all()
    tokens = _fold_text(q).split()
    if tokens:
        routes = [r for r in routes if _route_matches_tokens(r, tokens)]

    if point is None:
        return jsonify({'results': [_route_search_result(r) for r in routes[:limit]]})

    matches = []
    for route in routes:
        track = _route_track_points(route)
        vertices = track or _route_waypoint_points(route)
        if not vertices:
            continue
        distance = min(_haversine_km(point[0], point[1], v[0], v[1]) for v in vertices)
        if distance <= radius_km:
            matches.append((distance, route, track))
    matches.sort(key=lambda m: m[0])
    return jsonify({'results': [_route_search_result(route, distance, track)
                                for distance, route, track in matches[:limit]]})


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
    hazards                = data.get('hazards', [])
    route.ferrata_grade    = _submitted_ferrata_grade(data.get('ferrata_grade'), route.trail_type, hazards)
    route.hazards_json     = json.dumps(hazards)
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


@app.route('/routes/<int:route_id>/gpx')
@login_required
def export_gpx(route_id):
    route = Route.query.filter_by(id=route_id, user_id=current_user().id).first_or_404()
    filename = (secure_filename(route.name) or f'percorso-{route.id}') + '.gpx'
    response = Response(build_route_gpx(route), mimetype='application/gpx+xml')
    response.headers.set('Content-Disposition', 'attachment', filename=filename)
    return response


@app.route('/static/sw.js')
def sw():
    return send_from_directory('static', 'sw.js', mimetype='application/javascript')


with app.app_context():
    init_db()


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
