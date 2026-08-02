"""Fernet 암복호화 테스트."""

import pytest
from cryptography.fernet import Fernet, InvalidToken

from sooljang.infrastructure.security.secrets import decrypt_secret, encrypt_secret

_KEY_A = Fernet.generate_key().decode()
_KEY_B = Fernet.generate_key().decode()


def test_암호화한_값을_같은_키로_복호화하면_원문이_나온다() -> None:
    ciphertext = encrypt_secret("sk-abcdef1234567890", master_key=_KEY_A)
    assert decrypt_secret(ciphertext, master_key=_KEY_A) == "sk-abcdef1234567890"


def test_암호문은_원문을_담지_않는다() -> None:
    ciphertext = encrypt_secret("sk-abcdef1234567890", master_key=_KEY_A)
    assert b"sk-abcdef1234567890" not in ciphertext


def test_같은_원문도_암호문이_매번_다르다() -> None:
    # Fernet 은 매번 다른 IV 를 쓴다. 같으면 같은 키를 여러 번 저장했을 때 패턴이 드러난다.
    assert encrypt_secret("same-value", master_key=_KEY_A) != encrypt_secret(
        "same-value", master_key=_KEY_A
    )


def test_다른_마스터_키로는_복호화할_수_없다() -> None:
    ciphertext = encrypt_secret("sk-abcdef1234567890", master_key=_KEY_A)
    with pytest.raises(InvalidToken):
        decrypt_secret(ciphertext, master_key=_KEY_B)
