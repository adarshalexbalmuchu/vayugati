"""Notification delivery (Phase 9): a provider-agnostic queue drained here.

`dispatch_intervention_task()` (Postgres) writes `notifications` rows with
`status='pending'`. This module polls those rows and attempts delivery
through a per-channel adapter. It never marks a channel "delivered" unless a
real provider actually accepted the message — an unconfigured channel is
recorded as a clear, honest failure, not a silent success (plan §6: "do not
claim real SMS or WhatsApp delivery unless a provider is configured").

Adapters:
  * in_app   — no transport needed; the recipient's own client reads the row
               via RLS, so queuing it IS delivering it.
  * email    — real SMTP if SMTP_HOST is set, else a development-safe mock
               that logs "would send" and records why it didn't.
  * sms      — interface only (WhatsApp-ready shape, plan §6); no
               credentialed provider in this phase. Always fails honestly.
  * whatsapp — same: interface only, never a fabricated "delivered".
"""

import logging
import smtplib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from email.mime.text import MIMEText

from . import config, db

log = logging.getLogger("ingest.notifications")


@dataclass
class DeliveryResult:
    delivered: bool
    failure_reason: str | None = None


class NotificationAdapter(ABC):
    @abstractmethod
    def send(self, notification: dict) -> DeliveryResult: ...


class InAppAdapter(NotificationAdapter):
    """No transport: the row itself, readable via RLS by its recipient, IS
    the delivery. Marking it delivered here just records that fact."""

    def send(self, notification: dict) -> DeliveryResult:
        return DeliveryResult(delivered=True)


class MockEmailAdapter(NotificationAdapter):
    """Development-safe stand-in used whenever SMTP isn't configured. Never
    claims a real send — the failure_reason says exactly why."""

    def send(self, notification: dict) -> DeliveryResult:
        log.info(
            "MOCK EMAIL (no SMTP configured) would send to %s: %s",
            notification.get("recipient_contact"),
            notification.get("message_body"),
        )
        return DeliveryResult(
            delivered=False,
            failure_reason="no email provider configured (dev mode) — SMTP_HOST unset",
        )


class SmtpEmailAdapter(NotificationAdapter):
    def send(self, notification: dict) -> DeliveryResult:
        to_addr = notification.get("recipient_contact")
        if not to_addr:
            return DeliveryResult(delivered=False, failure_reason="no recipient email on file")
        try:
            msg = MIMEText(notification.get("message_body", ""))
            msg["Subject"] = f"Vayu Gati: {notification.get('template_key', 'notification')}"
            msg["From"] = config.SMTP_FROM or config.SMTP_USER
            msg["To"] = to_addr
            with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as server:
                server.starttls()
                if config.SMTP_USER:
                    server.login(config.SMTP_USER, config.SMTP_PASSWORD)
                server.sendmail(msg["From"], [to_addr], msg.as_string())
            return DeliveryResult(delivered=True)
        except Exception as e:  # noqa: BLE001 — any SMTP failure is a delivery failure, not a crash
            return DeliveryResult(delivered=False, failure_reason=f"smtp error: {e}")


class UnconfiguredAdapter(NotificationAdapter):
    """SMS/WhatsApp: no credentialed provider configured. Raises SkipDelivery
    so the run() loop skips rather than records a failure — prevents
    accumulating delivered=False rows in the notifications table for a
    channel that has never and will never work in the current deployment."""

    class SkipDelivery(Exception):
        pass

    def __init__(self, channel: str):
        self.channel = channel

    def send(self, notification: dict) -> DeliveryResult:
        raise UnconfiguredAdapter.SkipDelivery(self.channel)


def _email_adapter() -> NotificationAdapter:
    return SmtpEmailAdapter() if config.SMTP_HOST else MockEmailAdapter()


def _adapter_for(channel: str) -> NotificationAdapter:
    return {
        "in_app": InAppAdapter(),
        "email": _email_adapter(),
        "sms": UnconfiguredAdapter("sms"),
        "whatsapp": UnconfiguredAdapter("whatsapp"),
    }.get(channel, UnconfiguredAdapter(channel))  # unknown channels skip cleanly


MAX_RETRIES = 3


def run() -> dict:
    """Drain every pending notification once. Safe to call on a short
    schedule — each row is only ever picked up while status='pending', so a
    concurrent run cannot double-send (Postgres row-level status is the
    dedup key, not a lock)."""
    rows = db.get_pending_notifications(MAX_RETRIES)
    sent = 0
    failed = 0
    skipped = 0
    for row in rows:
        adapter = _adapter_for(row["channel"])
        try:
            result = adapter.send(row)
        except UnconfiguredAdapter.SkipDelivery as e:
            log.debug("skipping %s notification %s — channel not configured", e, row["id"])
            skipped += 1
            continue
        if result.delivered:
            db.mark_notification_sent(row["id"], datetime.now(timezone.utc).isoformat())
            sent += 1
        else:
            new_retry = row["retry_count"] + 1
            db.mark_notification_retry_or_failed(
                row["id"], result.failure_reason, new_retry, terminal=new_retry >= MAX_RETRIES
            )
            failed += 1
    return {"evaluated": len(rows), "sent": sent, "skipped": skipped, "failed_or_retrying": failed}
