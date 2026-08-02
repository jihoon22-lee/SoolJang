"""DB 에 저장하는 시크릿(LLM API 키 등)의 대칭 암호화.

비밀번호는 검증만 하면 되므로 단방향 해시(Argon2, `application/auth.py`)로 충분하다.
API 키는 LLM 호출 시 원문을 다시 꺼내 써야 하므로 해시가 아니라 **암호화**가 필요하다 —
`cryptography` 의 Fernet(AES-128-CBC + HMAC)을 쓴다. 자체 암호 구현을 만들지 않는다.

마스터 키(`Settings.secret_key`)는 이 모듈에 전역으로 두지 않고 호출부가 매번 넘긴다.
설정 로딩과 암복호화를 분리해 두면, 마스터 키 없이도 이 모듈만 단위 테스트할 수 있다.
"""

from cryptography.fernet import Fernet, InvalidToken

__all__ = ["InvalidToken", "decrypt_secret", "encrypt_secret"]


def encrypt_secret(plaintext: str, *, master_key: str) -> bytes:
    """평문을 암호화한다. 반환값은 그대로 DB 바이너리 컬럼에 저장할 수 있다."""
    return Fernet(master_key.encode()).encrypt(plaintext.encode())


def decrypt_secret(ciphertext: bytes, *, master_key: str) -> str:
    """암호문을 원문으로 복원한다. 마스터 키가 바뀌었으면 `InvalidToken` 을 던진다."""
    return Fernet(master_key.encode()).decrypt(ciphertext).decode()
