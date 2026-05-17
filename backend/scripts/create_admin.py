
from app.core import settings, engine, get_password_hash, SessionLocal
from app.models import User, SystemSetting
import json

db = SessionLocal()
try:
    # 创建 admin 用户
    if not db.query(User).filter(User.username == "admin").first():
        admin = User(
            username="admin",
            hashed_password=get_password_hash(settings.ADMIN_PASSWORD),
            role="admin"
        )
        db.add(admin)
        print(f"已创建 admin 用户，密码: {settings.ADMIN_PASSWORD}")
    
    # 创建 starter questions
    if not db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first():
        defaults = ["写一篇关于人工智能发展的报告", "解释量子纠缠", "帮我制定一个Python学习计划", "分析一下当前的经济形势"]
        db.add(SystemSetting(key="starter_questions", value=json.dumps(defaults)))
        print("已创建 starter questions")
    
    # 创建 model config
    if not db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first():
        db.add(SystemSetting(key="default_model_config", value=json.dumps({})))
        print("已创建 default model config")
    
    db.commit()
except Exception as e:
    print(f"错误: {e}")
    db.rollback()
finally:
    db.close()
