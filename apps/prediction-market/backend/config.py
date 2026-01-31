"""Configuration for the Prediction Market Agent."""

import os
from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings loaded from environment."""
    
    # App
    app_name: str = "Prediction Market Agent"
    debug: bool = False
    
    # Database
    db_path: Path = Field(
        default=Path(__file__).parent.parent / "data" / "trades.db"
    )
    
    # Logging
    log_path: Path = Field(
        default=Path(__file__).parent.parent / "logs"
    )
    trade_log_path: Path = Field(
        default=Path(__file__).parent.parent / "logs" / "trades.jsonl"
    )
    
    # Platforms (keys from environment)
    polymarket_private_key: str | None = Field(default=None, env="POLYMARKET_PRIVATE_KEY")
    kalshi_api_key: str | None = Field(default=None, env="KALSHI_API_KEY")
    kalshi_api_secret: str | None = Field(default=None, env="KALSHI_API_SECRET")
    
    # Trading limits
    max_position_size: float = 100.0  # Max $ per trade
    max_total_exposure: float = 1000.0  # Max total $ at risk
    paper_trading: bool = True  # Start in paper trading mode
    
    # Strategy defaults
    default_strategies: list[str] = ["nothing_ever_happens", "yield_farming"]
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
