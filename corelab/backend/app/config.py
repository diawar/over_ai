from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr
from pydantic import Field


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://corelab:local@localhost/corelab"
    session_secret: str = "development-only-secret-change-this-before-use"
    admin_username: str = "over_admin"
    admin_password: str = ""
    app_env: str = "local"
    cors_origins: str = "http://localhost:5173"
    ai_requests_per_minute: int = Field(default=30, ge=1, le=10000)
    ai_requests_per_day: int = Field(default=500, ge=1, le=1000000)
    ai_max_concurrent: int = Field(default=2, ge=1, le=100)
    # alias -> {token, organization_id?}; absent organization_id means shared bot.
    telegram_bots_json: SecretStr = SecretStr("{}")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings():
    return Settings()
