"""Phase 9 notification-delivery tests.

Every test monkeypatches app.db's notification functions and, where SMTP is
exercised, app.config's SMTP_* values — never a real network call, mirroring
this repo's test_forecast.py discipline (mock db.*/network, assert on the
resulting behaviour only).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import notifications  # noqa: E402


def test_in_app_adapter_always_reports_delivered():
    result = notifications.InAppAdapter().send({"recipient_contact": None})
    assert result.delivered is True
    assert result.failure_reason is None


def test_mock_email_adapter_never_claims_a_real_delivery():
    result = notifications.MockEmailAdapter().send(
        {"recipient_contact": "someone@example.com", "message_body": "hi"}
    )
    assert result.delivered is False
    assert "no email provider configured" in result.failure_reason


def test_unconfigured_sms_and_whatsapp_adapters_raise_skip_delivery():
    import pytest
    for channel in ("sms", "whatsapp"):
        with pytest.raises(notifications.UnconfiguredAdapter.SkipDelivery):
            notifications.UnconfiguredAdapter(channel).send({})


def test_adapter_selection_falls_back_to_mock_when_smtp_unconfigured(monkeypatch):
    monkeypatch.setattr(notifications.config, "SMTP_HOST", "")
    assert isinstance(notifications._adapter_for("email"), notifications.MockEmailAdapter)


def test_adapter_selection_uses_smtp_when_configured(monkeypatch):
    monkeypatch.setattr(notifications.config, "SMTP_HOST", "smtp.example.com")
    assert isinstance(notifications._adapter_for("email"), notifications.SmtpEmailAdapter)


def test_smtp_adapter_reports_failure_without_crashing_when_unreachable(monkeypatch):
    # No real SMTP server exists at this host:port — sendmail must fail
    # cleanly into a DeliveryResult, never raise out of send().
    monkeypatch.setattr(notifications.config, "SMTP_HOST", "127.0.0.1")
    monkeypatch.setattr(notifications.config, "SMTP_PORT", 1)  # nothing listens on port 1
    monkeypatch.setattr(notifications.config, "SMTP_USER", "")
    monkeypatch.setattr(notifications.config, "SMTP_FROM", "vayugati@example.com")
    result = notifications.SmtpEmailAdapter().send(
        {"recipient_contact": "officer@example.com", "message_body": "test", "template_key": "task_routed"}
    )
    assert result.delivered is False
    assert "smtp error" in result.failure_reason


def test_smtp_adapter_refuses_to_send_without_a_recipient_address():
    result = notifications.SmtpEmailAdapter().send({"recipient_contact": None, "message_body": "x"})
    assert result.delivered is False
    assert "no recipient email" in result.failure_reason


def test_run_marks_in_app_notifications_sent(monkeypatch):
    fake_rows = [
        {"id": 1, "channel": "in_app", "recipient_contact": None, "message_body": "m", "template_key": "t", "retry_count": 0},
    ]
    sent_calls = []
    monkeypatch.setattr(notifications.db, "get_pending_notifications", lambda max_retries: fake_rows)
    monkeypatch.setattr(notifications.db, "mark_notification_sent", lambda nid, ts: sent_calls.append((nid, ts)))
    monkeypatch.setattr(
        notifications.db, "mark_notification_retry_or_failed", lambda *a, **k: pytest_fail_if_called()
    )

    result = notifications.run()

    assert result == {"evaluated": 1, "sent": 1, "skipped": 0, "failed_or_retrying": 0}
    assert sent_calls[0][0] == 1


def test_run_retries_a_failed_email_up_to_the_retry_budget(monkeypatch):
    fake_rows = [
        {"id": 2, "channel": "email", "recipient_contact": None, "message_body": "m", "template_key": "t", "retry_count": 0},
    ]
    retry_calls = []
    monkeypatch.setattr(notifications.config, "SMTP_HOST", "")  # forces MockEmailAdapter -> always fails
    monkeypatch.setattr(notifications.db, "get_pending_notifications", lambda max_retries: fake_rows)
    monkeypatch.setattr(
        notifications.db,
        "mark_notification_retry_or_failed",
        lambda nid, reason, retry_count, terminal: retry_calls.append((nid, retry_count, terminal)),
    )

    result = notifications.run()

    assert result == {"evaluated": 1, "sent": 0, "skipped": 0, "failed_or_retrying": 1}
    assert retry_calls == [(2, 1, False)]  # first failure: retry_count 1, not yet terminal


def test_run_marks_terminal_failure_once_retry_budget_is_exhausted(monkeypatch):
    fake_rows = [
        {"id": 3, "channel": "email", "recipient_contact": None, "message_body": "m", "template_key": "t",
         "retry_count": notifications.MAX_RETRIES - 1},
    ]
    retry_calls = []
    monkeypatch.setattr(notifications.config, "SMTP_HOST", "")
    monkeypatch.setattr(notifications.db, "get_pending_notifications", lambda max_retries: fake_rows)
    monkeypatch.setattr(
        notifications.db,
        "mark_notification_retry_or_failed",
        lambda nid, reason, retry_count, terminal: retry_calls.append((nid, retry_count, terminal)),
    )

    notifications.run()

    assert retry_calls[0][2] is True  # terminal=True once retry_count reaches MAX_RETRIES


def pytest_fail_if_called(*_a, **_k):
    raise AssertionError("mark_notification_retry_or_failed should not be called for a successful send")
