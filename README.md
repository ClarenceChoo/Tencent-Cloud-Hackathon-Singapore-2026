# CareLoop — Tencent Cloud Hackathon Singapore 2026

CareLoop is a proposed voice companion for older adults: an ESP32-S3 pendant with push-to-talk, medication reminders, confirmed health notes, and a phone-friendly caregiver dashboard.

## Project documents

- [Product requirements document](docs/careloop/CareLoop-PRD.md): MVP scope, user journeys, requirements, acceptance criteria, and delivery plan.
- [Hardware–software integration guide](docs/careloop/Hardware-Software-Integration.md): hardware interfaces, firmware responsibilities, audio transport, backend APIs, and build sequence.
- [Chinese hardware supplier checklist](docs/careloop/Supplier-Handoff-Checklist-ZH.md): prototype scope, component requirements, testing, and supplier handoff.

## Connection plan

The pendant runs device firmware and exchanges audio and commands with a Tencent-hosted backend over Wi-Fi. The phone and caregiver dashboards access the same backend. Speech recognition, AI, and speech synthesis run through backend services.

The prototype uses the ESP32-S3 pendant from the start. There is no phone-based voice prototype. The phone remains a dashboard and optional Wi-Fi hotspot; it does not replace the pendant. Backend work can proceed with developer test fixtures while hardware is assembled.

The hardware supplier assembles and tests the pendant. The project team develops the firmware, backend, and dashboards.

## Current status

This repository currently contains the proposed product and integration specifications. Hardware connectivity, audio quality, battery life, and complete care flows still require implementation and testing.
