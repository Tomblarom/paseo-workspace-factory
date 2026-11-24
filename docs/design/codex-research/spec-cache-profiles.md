# Nutzerwunsch: Kompaktierung nach Kosten, Profil wie Energiesparoptionen (2026-11-24)

Quelle: Nutzer direkt an Steer E, auf Basis der Codex-Recherche (/tmp/codexres/an.py, OpenAI prompt-caching docs).

1. Einstellbar machen, wann aus Kostengründen kompaktiert wird. Eine Plugin-Einstellung als Profil wie bei Laptop-Energieoptionen:
   - "Maximale Effizienz": früh kompaktieren, auch bei kleinem Kontext.
   - "Ausgewogen" (Standard): kurz bevor der Cache abkühlt.
   - "Komfort": selten und spät kompaktieren, verbraucht mehr Usage. Nur ein Nebenprodukt, nicht aktiv ausbauen oder pflegen.
2. Eine stark vereinfachte Cache-Referenz je Modell bzw. Gruppe in der Factory hinterlegen (Doku plus Tabelle/Konstanten im Code). Sie dient als Grundlage für die angebotenen Stufen:
   | Gruppe | Cache-TTL | gecachter Input | Hinweis |
   |---|---|---|---|
   | Claude | 1 h (laut Abrechnungsweg ggf. 5 min) | ~0,1× | native /clear und /compact |
   | OpenAI GPT-5.6+ (gpt-6.x Sol/Terra/Astra) | Doku min. 30 min; gemessen: <30 min ~96 %, 30–180 min ~82 %, >3 h ≤30 % | 0,05× (Sol) | auto-compact selbst bei ~360–420k; /clear nicht nativ |
   | OpenAI ≤5.5 | 5–10 min (in_memory) bzw. ~30 min (24h) | modellabhängig | |
   | Muse, Copilot, sonstige | unbekannt | – | konservativ wie OpenAI ≥5.6 behandeln |
3. Automatisch kompaktieren, wenn alle drei Bedingungen gelten:
   - Der Steer droht laut Profilschwelle und Gruppen-TTL kalt zu werden.
   - Er wird gerade nicht benutzt: kein laufender Turn, keine offene Nutzereingabe/Aktion.
   - Beim Anbieter ist Kontingent vorhanden: Provider-Limit oder Usage prüfen, sonst nichts tun.
   Codex nur mit /compact, nie /clear. Kontext, der schon kalt ist, nicht mehr kompaktieren, sondern beim Resume fresh plus Brief nutzen.
4. Worker ebenfalls betreuen, nicht nur Steers. Als TODO-Punkt vorsehen, falls nicht schon vorhanden.

Leitsatz: Kein Agent soll mit großem Kontext kalt werden. Ein kleiner, kompaktierter Kontext darf kalt werden, denn das ist billiger als ein Dauer-Warmhalten.
