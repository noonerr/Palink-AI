
from app.core import get_password_hash, SessionLocal
from app.models import User

db = SessionLocal()
try:
    # 查找 admin 用户
    admin_user = db.query(User).filter(User.username == "admin").first()
    if admin_user:
        # 更新密码为 admin123
        admin_user.hashed_password = get_password_hash("admin123")
        db.commit()
        print("已成功更新 admin 密码为 admin123")
    else:
        print("未找到 admin 用户")
except Exception as e:
    print(f"错误: {e}")
    db.rollback()
finally:
    db.close()
