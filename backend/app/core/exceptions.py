class ServiceError(Exception):
    def __init__(self, message: str, code: str = "SERVICE_ERROR", status_code: int = 500):
        self.message = message
        self.code = code
        self.status_code = status_code
        super().__init__(self.message)
