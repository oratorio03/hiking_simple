# HikePath

Flask webapp per pianificare e salvare percorsi hiking con mappa, profilo altimetrico e navigazione GPS via browser.

## Avvio locale

```powershell
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
$env:SECRET_KEY="dev-secret-change-me"
venv\Scripts\python.exe app.py
```

Apri `http://localhost:5000`.

## Deploy Render

Il progetto include `render.yaml`.

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app`
- Env var richiesta: `SECRET_KEY`

Render genera `SECRET_KEY` dal file `render.yaml`. Il database SQLite viene creato in `instance/hiking.db` all'import dell'app. Questa e' una soluzione minima: senza disco persistente Render, i dati possono andare persi tra redeploy o reset dell'istanza.
