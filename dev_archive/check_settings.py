import json
from app.database import SessionLocal, SystemSetting

db = SessionLocal()
settings = db.query(SystemSetting).all()
print('Current settings:')
for s in settings:
    if len(s.value) > 100:
        print(f'{s.key}: {s.value[:100]}...')
    else:
        print(f'{s.key}: {s.value}')
db.close()