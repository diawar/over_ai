from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://corelab:local@localhost/corelab"
    session_secret: str = "development-only-secret-change-this-before-use"
    admin_username: str = "over_admin"
    admin_password: str = ""
    app_env: str = "local"
    cors_origins: str = "http://localhost:5173"
    # alias -> {token, organization_id?}; absent organization_id means shared bot.
    telegram_bots_json: SecretStr = SecretStr("{}")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings():
    return Settings()
