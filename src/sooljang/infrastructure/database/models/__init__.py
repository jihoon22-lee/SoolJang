"""ORM 모델.

Alembic 이 `Base.metadata` 를 통해 스키마를 인식하므로, 새 모델을 만들면 반드시 여기에
등록해야 한다. 등록을 잊으면 마이그레이션 자동 생성이 테이블을 놓치고, `alembic check` 가
드리프트로 잡아낸다.
"""

from sooljang.infrastructure.database.models.auth import Session, User
from sooljang.infrastructure.database.models.auth_enums import UserRole
from sooljang.infrastructure.database.models.category import Category, Producer, Variety
from sooljang.infrastructure.database.models.category_seed import CategorySeed
from sooljang.infrastructure.database.models.external_source import (
    ExternalLookupCache,
    ExternalProductMatch,
    ExternalSource,
    ExternalSourceCredential,
    ExternalSourceProbe,
)
from sooljang.infrastructure.database.models.inventory import (
    IN_STOCK_STATUSES,
    Bottle,
    BottleStatus,
    Purchase,
    Vendor,
    VendorKind,
)
from sooljang.infrastructure.database.models.llm import (
    DEFAULT_OPENAI_MODEL,
    LlmProvider,
    LlmSetting,
)
from sooljang.infrastructure.database.models.product import (
    MAX_PERSONAL_RATING,
    BarcodeType,
    Product,
    ProductVariety,
    Sku,
)
from sooljang.infrastructure.database.models.saved_view import SavedView
from sooljang.infrastructure.database.models.sync import ConflictLog, OutboxReceipt, SyncCursor
from sooljang.infrastructure.database.models.tasting import (
    MAX_RATING,
    RATING_STEP,
    Attachment,
    AttachmentKind,
    TastingSession,
)

__all__ = [
    "DEFAULT_OPENAI_MODEL",
    "MAX_RATING",
    "RATING_STEP",
    "Attachment",
    "AttachmentKind",
    "IN_STOCK_STATUSES",
    "MAX_PERSONAL_RATING",
    "BarcodeType",
    "Bottle",
    "BottleStatus",
    "Category",
    "CategorySeed",
    "ConflictLog",
    "ExternalLookupCache",
    "ExternalProductMatch",
    "ExternalSource",
    "ExternalSourceCredential",
    "ExternalSourceProbe",
    "LlmProvider",
    "LlmSetting",
    "OutboxReceipt",
    "Producer",
    "Product",
    "ProductVariety",
    "SavedView",
    "Session",
    "SyncCursor",
    "TastingSession",
    "Purchase",
    "Sku",
    "User",
    "UserRole",
    "Variety",
    "Vendor",
    "VendorKind",
]
