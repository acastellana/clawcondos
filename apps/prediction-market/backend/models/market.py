"""Market model - represents a prediction market."""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field
from sqlalchemy import Column, String, Float, DateTime, Text, Boolean
from .trade import Base


class MarketDB(Base):
    """SQLAlchemy model for markets."""
    
    __tablename__ = "markets"
    
    id = Column(String, primary_key=True)  # platform:market_id
    platform = Column(String, nullable=False)
    market_id = Column(String, nullable=False)
    
    # Market info
    question = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    category = Column(String, nullable=True)
    end_date = Column(DateTime, nullable=True)
    
    # Current prices
    yes_price = Column(Float, nullable=True)
    no_price = Column(Float, nullable=True)
    volume = Column(Float, nullable=True)
    liquidity = Column(Float, nullable=True)
    
    # Our analysis
    our_probability = Column(Float, nullable=True)  # What we think
    expected_value = Column(Float, nullable=True)
    strategy_signals = Column(Text, nullable=True)  # JSON
    
    # Resolution
    resolved = Column(Boolean, default=False)
    resolution_outcome = Column(String, nullable=True)
    resolution_date = Column(DateTime, nullable=True)
    
    # Timestamps
    first_seen = Column(DateTime, default=datetime.utcnow)
    last_updated = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# Pydantic models

class MarketBase(BaseModel):
    """Base market model."""
    platform: str
    market_id: str
    question: str
    description: Optional[str] = None
    category: Optional[str] = None
    end_date: Optional[datetime] = None


class MarketCreate(MarketBase):
    """Model for creating a market record."""
    yes_price: Optional[float] = None
    no_price: Optional[float] = None
    volume: Optional[float] = None


class Market(MarketBase):
    """Full market model."""
    id: str
    yes_price: Optional[float] = None
    no_price: Optional[float] = None
    volume: Optional[float] = None
    liquidity: Optional[float] = None
    our_probability: Optional[float] = None
    expected_value: Optional[float] = None
    strategy_signals: Optional[dict] = None
    resolved: bool = False
    resolution_outcome: Optional[str] = None
    resolution_date: Optional[datetime] = None
    first_seen: datetime
    last_updated: datetime
    
    class Config:
        from_attributes = True


class MarketOpportunity(BaseModel):
    """A market opportunity flagged by a strategy."""
    market: Market
    strategy: str
    signal_strength: float = Field(ge=0, le=1)
    recommended_side: str
    recommended_amount: float
    expected_value: float
    reasoning: str
