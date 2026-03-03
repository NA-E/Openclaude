# Link Reminder

Type a message with a link → get reminded when you sit back at your laptop.

## How it works

- **You type** in a browser tab at `http://localhost:3000`
- **It saves** the link and note to `reminders.json`
- **Every 5 minutes**, a tiny script checks if you just returned (idle time dropped) or woke from sleep
- **When you're back**, it opens `localhost:3000/pending` in your browser — links are fully selectable and copyable

No API key needed. No cloud. Runs entirely on your machine.

## Install

```powershell
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Register Task Scheduler tasks (run once, from this directory)
.\setup.ps1

# 3. Reboot or start manually for first use
python server.py
```

## Files

| File | Purpose |
|------|---------|
| `server.py` | Flask server at localhost:3000 |
| `check.py` | Presence detector — runs every 5 min via Task Scheduler |
| `static/index.html` | Chat UI |
| `reminders.json` | Your saved reminders (auto-created) |
| `state.json` | Idle state tracking (auto-created) |
| `setup.ps1` | Registers both Task Scheduler tasks |

## Testing check.py manually

Edit `check.py` and temporarily lower the thresholds for quick testing:

```python
AWAY_THRESHOLD_SECONDS = 10   # was 300
ACTIVE_THRESHOLD_SECONDS = 5  # was 90
```

Then: wait 10 seconds without touching keyboard/mouse, move the mouse, run `python check.py`.
The pending reminders page should open in your browser.

Restore to defaults after testing.

## Presence detection

Two signals trigger reminder delivery:

1. **Idle drop** — you were away (idle > 5 min) and are now active (idle < 90s)
2. **Wake from sleep** — gap since last check was > 10 min and you're now active

If you never leave your laptop, nothing fires. Reminders only appear when you return.
