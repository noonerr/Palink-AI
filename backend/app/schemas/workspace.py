from typing import List, Optional
from pydantic import BaseModel

class AnalyzeRequest(BaseModel):
    file_id: str

class UploadRequest(BaseModel):
    filename: str
    content: str
    folder_id: Optional[str] = None

class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None

class FileMove(BaseModel):
    item_ids: List[str]
    target_folder_id: Optional[str] = None
