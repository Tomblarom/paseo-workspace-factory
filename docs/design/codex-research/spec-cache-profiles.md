# Cache-Profile für die Kompaktierung (2026-11-24)

Die Profile legen fest, ab welcher Leerlaufdauer die Factory einen Agenten für eine Kompaktierung in Betracht zieht. Die Cache-Zeiten sind Richtwerte für die Entscheidung. [Codex-Messungen](findings-compact-vs-fresh.md) · [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Cache-Referenz der Factory](../cold-context-resume.md#cache-reference-and-cost-profiles)

- **Maximale Effizienz** prüft früh und berücksichtigt kleinere Kontexte.
- **Ausgewogen** prüft kurz vor der geschätzten Ablaufzeit und ist das Standardprofil.
- **Komfort** prüft später, kurz vor Ende des Kompaktierungsfensters.

In der Leerlaufprüfung gelten dieselben Voraussetzungen für die konfigurierten Steers und Worker. Ein laufender Turn oder eine offene Aktion blockiert die Bereinigung. Für eine Kompaktierung braucht es einen noch warmen Cache und verfügbares Kontingent. Bei kaltem Kontext empfiehlt die Factory `fresh` mit Wiederaufnahmebrief. Codex nutzt für Kompaktierung `/compact`. [Leerlaufprüfung](../cold-context-resume.md#c5-idle-cleanup-plugin-timer)

Die Entscheidung berücksichtigt auch, ob ein Arbeitspaket abgeschlossen ist. Ein frischer Arbeitsstand aus dem Checkpoint kann dann günstiger sein als eine weitere Kompaktierung. Für kleine Kontexte kann es günstiger sein, den Cache auslaufen zu lassen.
