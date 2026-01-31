"""Trade model - core data structure for logging trades."""

from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field
from sqlalchemy import Column, String, Float, DateTime, Text, Enum as SQLEnum, Boolean
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class TradeStatus(str, Enum):
    """Status of a trade."""
    OPEN = "open"
    RESOLVED_WIN = "resolved_win"
    RESOLVED_LOSS = "resolved_loss"
    CANCELLED = "cancelled"


class TradeSide(str, Enum):
    """Side of the trade."""
    YES = "yes"
    NO = "no"


class TradeDB(Base):
    """SQLAlchemy model for trades."""
    
    __tablename__ = "trades"
    
    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Platform & Market
    platform = Column(String, nullable=False)  # polymarket, kalshi, limitless
    market_id = Column(String, nullable=False)
    market_question = Column(Text, nullable=False)
    market_category = Column(String, nullable=True)
    market_end_date = Column(DateTime, nullable=True)
    
    # Trade details
    side = Column(String, nullable=False)  # yes, no
    entry_price = Column(Float, nullable=False)
    amount = Column(Float, nullable=False)
    shares = Column(Float, nullable=True)  # Calculated: amount / entry_price
    
    # Strategy
    strategy = Column(String, nullable=False)
    entry_context = Column(Text, nullable=True)  # JSON string of context
    
    # Status & Resolution
    status = Column(String, default=TradeStatus.OPEN)
    resolution_date = Column(DateTime, nullable=True)
    resolution_outcome = Column(String, nullable=True)  # yes, no
    closing_price = Column(Float, nullable=True)  # Price at market close
    
    # Results
    pnl = Column(Float, nullable=True)
    roi = Column(Float, nullable=True)  # Return on investment %
    
    # Self-improvement metrics
    clv = Column(Float, nullable=True)  # Closing Line Value
    was_good_trade = Column(Boolean, nullable=True)  # Beat CLV?
    lessons = Column(Text, nullable=True)  # What we learned
    quality_rating = Column(Float, nullable=True)  # Manual 1-5 rating


# Pydantic models for API

class TradeBase(BaseModel):
    """Base trade model."""
    platform: str
    market_id: str
    market_question: str
    market_category: Optional[str] = None
    market_end_date: Optional[datetime] = None
    side: TradeSide
    entry_price: float = Field(ge=0.01, le=0.99)
    amount: float = Field(gt=0)
    strategy: str
    entry_context: Optional[dict] = None


class TradeCreate(TradeBase):
    """Model for creating a new trade."""
    pass


class TradeUpdate(BaseModel):
    """Model for updating a trade (resolution)."""
    status: Optional[TradeStatus] = None
    resolution_date: Optional[datetime] = None
    resolution_outcome: Optional[str] = None
    closing_price: Optional[float] = None
    pnl: Optional[float] = None
    clv: Optional[float] = None
    was_good_trade: Optional[bool] = None
    lessons: Optional[str] = None
    quality_rating: Optional[float] = None


class Trade(TradeBase):
    """Full trade model with all fields."""
    id: str
    created_at: datetime
    updated_at: datetime
    shares: Optional[float] = None
    status: TradeStatus = TradeStatus.OPEN
    resolution_date: Optional[datetime] = None
    resolution_outcome: Optional[str] = None
    closing_price: Optional[float] = None
    pnl: Optional[float] = None
    roi: Optional[float] = None
    clv: Optional[float] = None
    was_good_trade: Optional[bool] = None
    lessons: Optional[str] = None
    quality_rating: Optional[float] = None
    
    class Config:
        from_attributes = True
