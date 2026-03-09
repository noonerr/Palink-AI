import json
import os
import logging
import uuid
import re
import shutil
import base64
import mimetypes
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from openai import AsyncOpenAI
from passlib.context import CryptContext
from jose import JWTError, jwt

from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, DateTime, ForeignKey, Text, text, BigInteger
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship, Session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
WORKSPACE_DIR = os.path.join(DATA_DIR, "workspace")

for d in [DATA_DIR, UPLOAD_DIR, WORKSPACE_DIR]:
    if not os.path.exists(d): os.makedirs(d)

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{os.path.join(DATA_DIR, 'palink.db')}")
CONFIG_FILE = os.path.join(DATA_DIR, "providers.json")

if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(String, default="user") 
    is_active = Column(Boolean, default=True)
    avatar = Column(String, nullable=True) 
    storage_used = Column(BigInteger, default=0)
    sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")
    files = relationship("UserFile", back_populates="user", cascade="all, delete-orphan")
    folders = relationship("UserFolder", back_populates="user", cascade="all, delete-orphan")

class ChatSession(Base):
    __tablename__ = "sessions"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String)
    updated_at = Column(DateTime, default=datetime.utcnow)
    user = relationship("User", back_populates="sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")

class ChatMessage(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"))
    role = Column(String)
    content = Column(Text)
    model = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    tokens = Column(Integer, default=0)
    session = relationship("ChatSession", back_populates="messages")

class SystemSetting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(String) 

class UserFolder(Base):
    __tablename__ = "user_folders"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String)
    parent_id = Column(String, nullable=True) 
    created_at = Column(DateTime, default=datetime.utcnow)
    user = relationship("User", back_populates="folders")
    files = relationship("UserFile", back_populates="folder", cascade="all, delete-orphan")

class UserFile(Base):
    __tablename__ = "user_files"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"))
    folder_id = Column(String, ForeignKey("user_folders.id"), nullable=True) 
    filename = Column(String)
    file_path = Column(String) 
    file_size = Column(BigInteger)
    mime_type = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    user = relationship("User", back_populates="files")
    folder = relationship("UserFolder", back_populates="files")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("PalinkAI")

app = FastAPI(title="Palink AI Enterprise API v12.1")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

SECRET_KEY = "palink-secret-v35-stable"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7
USER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/token")

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w') as f: json.dump([], f)
    
    db = SessionLocal()
    try:
        if not db.query(User).filter(User.username == "admin").first():
            admin = User(username="admin", hashed_password=pwd_context.hash("admin123"), role="admin")
            db.add(admin)
        if not db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first():
            defaults = ["写一篇关于人工智能发展的报告", "解释量子纠缠", "帮我制定一个Python学习计划", "分析一下当前的经济形势"]
            db.add(SystemSetting(key="starter_questions", value=json.dumps(defaults)))
        db.commit()
    except Exception as e: logger.error(f"Startup error: {e}")
    finally: db.close()

# Models
class ModelItem(BaseModel):
    id: str
    alias: str
    icon: Optional[str] = "🤖"
    description: Optional[str] = ""
    context_length: Optional[int] = 4096 

class ProviderConfig(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    models: List[ModelItem]
    is_active: bool = True

class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str
    model: str
    temperature: float = 0.6
    images: List[str] = [] 
    files: List[str] = [] 

class UploadRequest(BaseModel):
    filename: str
    data: str 

class BatchDeleteRequest(BaseModel):
    session_ids: List[str]

class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None

class FileMove(BaseModel):
    file_ids: List[str]
    folder_ids: List[str] 
    target_folder_id: Optional[str] 
    
class PasswordReset(BaseModel):
    password: str

class UserUpdate(BaseModel):
    avatar: Optional[str] = None
    username: Optional[str] = None

class ChangePassword(BaseModel):
    old_password: str
    new_password: str

# Helpers
def get_providers():
    try:
        with open(CONFIG_FILE, 'r') as f: return json.load(f)
    except: return []

def save_providers(data):
    with open(CONFIG_FILE, 'w') as f: json.dump(data, f, ensure_ascii=False, indent=2)

def find_model_config(model_id):
    for p in get_providers():
        if p.get('is_active'):
            for m in p.get('models', []):
                mid = m['id'] if isinstance(m, dict) else m
                if mid == model_id:
                    m_dict = m if isinstance(m, dict) else {"id": m, "context_length": 4096}
                    return p, m_dict
    return None, None

def create_token(data: dict):
    to_encode = data.copy()
    to_encode.update({"exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
    except: raise HTTPException(401)
    user = db.query(User).filter(User.username == username).first()
    if not user: raise HTTPException(401)
    return user

async def get_admin(user: User = Depends(get_current_user)):
    if user.role != "admin": raise HTTPException(403)
    return user

# Workspace Routes
@app.get("/api/workspace")
async def get_workspace(parent_id: Optional[str] = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folders = db.query(UserFolder).filter(UserFolder.user_id == user.id, UserFolder.parent_id == parent_id).all()
    files = db.query(UserFile).filter(UserFile.user_id == user.id, UserFile.folder_id == parent_id).all()
    path = []
    current = parent_id
    while current:
        f = db.query(UserFolder).filter(UserFolder.id == current).first()
        if f: path.insert(0, {"id": f.id, "name": f.name}); current = f.parent_id
        else: break
    return {
        "folders": [{"id": f.id, "name": f.name, "created_at": f.created_at} for f in folders],
        "files": [{"id": f.id, "filename": f.filename, "size": f.file_size, "url": f"/api/workspace/file/{f.id}", "type": f.mime_type, "created_at": f.created_at} for f in files],
        "path": path,
        "usage": user.storage_used,
        "limit": USER_QUOTA_BYTES
    }

@app.post("/api/workspace/folder")
async def create_folder(req: FolderCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Explicitly check for empty string parent_id and convert to None if needed, 
    # though SQL usually handles NULL. Frontend now sends specific values.
    pid = req.parent_id if req.parent_id else None
    db.add(UserFolder(user_id=user.id, name=req.name, parent_id=pid))
    db.commit()
    return {"status": "ok"}

@app.post("/api/workspace/upload")
async def upload_workspace_file(file: UploadFile = File(...), folder_id: Optional[str] = Form(None), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    file.file.seek(0, 2); size = file.file.tell(); file.file.seek(0)
    if (user.storage_used or 0) + size > USER_QUOTA_BYTES: raise HTTPException(400, "Quota exceeded")
    safe_name = f"{uuid.uuid4()}_{file.filename}"
    user_dir = os.path.join(WORKSPACE_DIR, str(user.id))
    if not os.path.exists(user_dir): os.makedirs(user_dir)
    file_path = os.path.join(user_dir, safe_name)
    with open(file_path, "wb") as f: shutil.copyfileobj(file.file, f)
    
    # Handle 'null' string or empty string from frontend
    fid = None if folder_id == 'null' or not folder_id else folder_id
    
    db_file = UserFile(user_id=user.id, folder_id=fid, filename=file.filename, file_path=file_path, file_size=size, mime_type=file.content_type or "application/octet-stream")
    user.storage_used = (user.storage_used or 0) + size
    db.add(db_file); db.commit()
    return {"status": "ok", "file": {"id": db_file.id, "filename": db_file.filename}}

@app.post("/api/workspace/move")
async def move_items(req: FileMove, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if req.file_ids:
        db.query(UserFile).filter(UserFile.id.in_(req.file_ids), UserFile.user_id == user.id).update({"folder_id": req.target_folder_id}, synchronize_session=False)
    if req.folder_ids:
        if req.target_folder_id in req.folder_ids: raise HTTPException(400, "Loop detected")
        db.query(UserFolder).filter(UserFolder.id.in_(req.folder_ids), UserFolder.user_id == user.id).update({"parent_id": req.target_folder_id}, synchronize_session=False)
    db.commit()
    return {"status": "ok"}

@app.delete("/api/workspace/delete")
async def delete_items(req: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    file_ids = req.get('file_ids', [])
    folder_ids = req.get('folder_ids', [])
    
    files = db.query(UserFile).filter(UserFile.id.in_(file_ids), UserFile.user_id == user.id).all()
    freed = 0
    for f in files:
        if os.path.exists(f.file_path): 
            try: os.remove(f.file_path)
            except: pass
        freed += f.file_size
        db.delete(f)
    
    if folder_ids:
        folders = db.query(UserFolder).filter(UserFolder.id.in_(folder_ids), UserFolder.user_id == user.id).all()
        for fol in folders: db.delete(fol) 
    
    user.storage_used = max(0, (user.storage_used or 0) - freed)
    db.commit()
    return {"status": "ok"}

@app.get("/api/workspace/file/{file_id}")
async def download_workspace_file(file_id: str, db: Session = Depends(get_db)):
    f = db.query(UserFile).filter(UserFile.id == file_id).first()
    if not f or not os.path.exists(f.file_path): raise HTTPException(404, "File not found")
    return FileResponse(f.file_path, filename=f.filename)

# Chat & Recs
@app.get("/api/recommendations/starters")
async def get_starter_questions(db: Session = Depends(get_db)):
    setting = db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first()
    if setting: return json.loads(setting.value)
    return []

@app.post("/api/admin/recommendations/starters")
async def update_starter_questions(questions: List[str], u: User = Depends(get_admin), db: Session = Depends(get_db)):
    existing = db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first()
    if existing: existing.value = json.dumps(questions)
    else: db.add(SystemSetting(key="starter_questions", value=json.dumps(questions)))
    db.commit()
    return {"status": "ok"}

@app.post("/api/chat/suggestions")
async def generate_chat_suggestions(req: ChatRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    provider, _ = find_model_config(req.model)
    if not provider: return [] 
    client = AsyncOpenAI(api_key=provider['api_key'], base_url=provider['base_url'])
    prompt = f"Based on this, generate 3 short follow-up questions in JSON format like ['Q1', 'Q2']: {req.message[:2000]}"
    try:
        resp = await client.chat.completions.create(model=req.model, messages=[{"role": "user", "content": prompt}], temperature=0.7)
        content = resp.choices[0].message.content
        import re
        json_match = re.search(r'\[.*\]', content, re.DOTALL)
        if json_match: return json.loads(json_match.group(0))
        return []
    except: return []

@app.post("/api/chat")
async def chat_stream(req: ChatRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    provider, model_config = find_model_config(req.model)
    if not provider: raise HTTPException(400, "Provider not found")
    
    context_text = ""
    for file_ref in req.files:
        content = ""
        if "/api/workspace/file/" in file_ref:
            fid = file_ref.split("/")[-1]
            f = db.query(UserFile).filter(UserFile.id == fid).first()
            if f and os.path.exists(f.file_path):
                try:
                    with open(f.file_path, 'r', encoding='utf-8', errors='ignore') as fo:
                        content = fo.read(30000)
                except:
                    content = "[Binary]"
        context_text += f"\nFile: {file_ref}\nContent:\n{content}\n---\n"
            
    final_user_content = req.message + context_text
    
    if req.images:
        content_payload = [{"type": "text", "text": final_user_content}]
        for img_url in req.images: content_payload.append({ "type": "image_url", "image_url": {"url": img_url} })
        user_message = {"role": "user", "content": content_payload}
    else:
        user_message = {"role": "user", "content": final_user_content}

    if not req.session_id:
        req.session_id = str(uuid.uuid4())
        title = req.message[:30] if req.message else "New Chat"
        db.add(ChatSession(id=req.session_id, user_id=user.id, title=title))
    else:
        db.query(ChatSession).filter(ChatSession.id==req.session_id).update({"updated_at": datetime.utcnow()})
    
    db.add(ChatMessage(session_id=req.session_id, role="user", content=req.message, model=req.model))
    db.commit()

    max_ctx = model_config.get('context_length', 4096)
    history = db.query(ChatMessage).filter(ChatMessage.session_id == req.session_id).order_by(ChatMessage.created_at.desc()).limit(20).all()
    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    current_tokens = len(final_user_content) // 2 
    for m in reversed(history):
        msg_tokens = len(m.content or "") // 2
        if current_tokens + msg_tokens > max_ctx: break
        messages.append({"role": m.role, "content": m.content})
        current_tokens += msg_tokens
    messages.append(user_message)

    async def event_generator():
        try:
            client = AsyncOpenAI(api_key=provider['api_key'], base_url=provider['base_url'])
            stream = await client.chat.completions.create(model=req.model, messages=messages, temperature=req.temperature, stream=True)
            full_content = ""; full_reasoning = ""
            async for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta
                    reasoning = getattr(delta, 'reasoning_content', None) or getattr(delta, 'reasoning', None)
                    content = delta.content
                    resp = {}
                    if reasoning: full_reasoning += reasoning; resp['reasoning'] = reasoning
                    if content: full_content += content; resp['content'] = content
                    if resp: yield f"data: {json.dumps(resp, ensure_ascii=False)}\n\n"
            
            total_tokens = current_tokens + (len(full_content) // 2)
            yield f"data: {json.dumps({'type': 'usage', 'total_tokens': total_tokens})}\n\n"
            yield "data: [DONE]\n\n"
            
            final = f"<think>{full_reasoning}</think>\n{full_content}" if full_reasoning else full_content
            new_db = SessionLocal()
            try:
                new_db.add(ChatMessage(session_id=req.session_id, role="assistant", content=final, model=req.model, tokens=total_tokens))
                new_db.commit()
            finally: new_db.close()
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'content': f'Error: {str(e)}'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.delete("/api/sessions/batch")
async def batch_delete_sessions(req: BatchDeleteRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sessions = db.query(ChatSession).filter(ChatSession.id.in_(req.session_ids), ChatSession.user_id == user.id).all()
    if not sessions: return {"status": "ok"}
    ids = [s.id for s in sessions]
    db.query(ChatSession).filter(ChatSession.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    return {"status": "ok"}

# Auth
@app.post("/api/token")
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not pwd_context.verify(form_data.password, user.hashed_password): raise HTTPException(400, "Auth failed")
    return {"access_token": create_token({"sub": user.username, "role": user.role}), "token_type": "bearer"}

@app.post("/api/register")
async def register(req: dict, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == req['username']).first(): raise HTTPException(400, "User exists")
    db.add(User(username=req['username'], hashed_password=pwd_context.hash(req['password'])))
    db.commit()
    return {"status": "ok"}

@app.get("/api/users/me")
async def get_my_profile(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "role": user.role, "avatar": user.avatar}

@app.put("/api/users/me")
async def update_my_profile(req: UserUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if req.avatar is not None: user.avatar = req.avatar
    if req.username is not None:
        # Check uniqueness
        existing = db.query(User).filter(User.username == req.username, User.id != user.id).first()
        if existing: raise HTTPException(400, "Username taken")
        user.username = req.username
    db.commit()
    return {"status": "ok"}

@app.post("/api/users/me/password")
async def change_my_password(req: ChangePassword, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not pwd_context.verify(req.old_password, user.hashed_password):
        raise HTTPException(400, "Wrong old password")
    user.hashed_password = pwd_context.hash(req.new_password)
    db.commit()
    return {"status": "ok"}

@app.get("/api/sessions")
async def get_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(ChatSession).filter(ChatSession.user_id == user.id).order_by(ChatSession.updated_at.desc()).all()

@app.get("/api/sessions/{sid}/messages")
async def get_messages(sid: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(ChatMessage).filter(ChatMessage.session_id == sid).order_by(ChatMessage.created_at).all()

@app.get("/api/models")
async def get_models():
    res = []
    for p in get_providers():
        if p.get('is_active'):
            for m in p.get('models', []):
                if isinstance(m, dict):
                    res.append({"id": m['id'], "name": m['alias'], "icon": m.get('icon', '🤖'), "description": m.get('description', ''), "provider": p['name'], "context_length": m.get('context_length', 4096)})
                else:
                    res.append({"id": m, "name": m, "icon": "🤖", "provider": p['name'], "context_length": 4096})
    return res

@app.post("/api/upload")
async def upload_file_base64(req: UploadRequest, user: User = Depends(get_current_user)):
    try:
        data_parts = req.data.split(",", 1)
        encoded_data = data_parts[1] if len(data_parts) == 2 else req.data
        file_bytes = base64.b64decode(encoded_data)
        unique_name = f"{uuid.uuid4()}_{req.filename}"
        filepath = os.path.join(UPLOAD_DIR, unique_name)
        with open(filepath, "wb") as f: f.write(file_bytes)
        return {"url": f"/api/uploads/{unique_name}", "filename": req.filename}
    except Exception as e: raise HTTPException(500, str(e))

# Admin Specific Routes
@app.get("/api/admin/users")
async def list_users(u: User = Depends(get_admin), db: Session = Depends(get_db)): return db.query(User).all()

@app.delete("/api/admin/users/{user_id}")
async def delete_user(user_id: int, u: User = Depends(get_admin), db: Session = Depends(get_db)):
    usr = db.query(User).filter(User.id == user_id).first()
    if usr:
        db.delete(usr)
        db.commit()
    return {"status": "ok"}

@app.post("/api/admin/users/{user_id}/reset_password")
async def reset_password(user_id: int, req: PasswordReset, u: User = Depends(get_admin), db: Session = Depends(get_db)):
    usr = db.query(User).filter(User.id == user_id).first()
    if usr:
        usr.hashed_password = pwd_context.hash(req.password)
        db.commit()
    return {"status": "ok"}

@app.get("/api/admin/users/{user_id}/chats")
async def get_user_chats(user_id: int, u: User = Depends(get_admin), db: Session = Depends(get_db)):
    return db.query(ChatSession).filter(ChatSession.user_id == user_id).order_by(ChatSession.updated_at.desc()).all()

@app.get("/api/admin/providers")
async def get_providers_api(u: User = Depends(get_admin)): return get_providers()
@app.post("/api/admin/providers")
async def save_providers_api(data: List[ProviderConfig], u: User = Depends(get_admin)): save_providers([d.dict() for d in data]); return {"status": "ok"}