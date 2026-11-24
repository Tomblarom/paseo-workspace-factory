# Codex: Kompaktieren vs. neu anlegen (Steer E, 2026-11-24)

Messung aus ~/.codex/sessions (36 Kompaktierungen, 69 Sessions):
- Der /compact- bzw. Auto-Compact-Turn meldet lokal 0 Token. Codex kompaktiert serverseitig (`/responses/compact`); die eigentlichen Kosten sind lokal nicht sichtbar.
- Erster Turn nach dem Compact: 24–73k Input, davon nur ~12k gecacht (gemeinsames Präfix). Es werden also 12–60k ungecacht gelesen.
- Mehrfach-Compact in einer Session: die Basis wächst, z. B. 39k → 46k → 49k → 67k → 73k bzw. 34k → 44k → 50k.
- Neu anlegen (Live-Test Steer B, 8f8dd781): erster Turn 20,6k Input, davon 14k gecacht, also ~6,6k ungecacht. Der Brief selbst hat ~400 Token. Die Kosten hängen nicht davon ab, ob der Cache des alten Agenten warm ist.
- Neue Sessions wachsen durch erneutes Lesen von Dateien: Median 95k bei Request 20, 239k bei Request 100.

Literatur (Details im Chat von E):
- Anthropic „Effective harnesses for long-running agents“: Compaction allein reicht nicht; empfohlen werden neue Session plus Progress-Datei, Git und Feature-Liste.
- Claude-Code-Doku: /compact bei warmem Cache günstig, nach TTL teuer; jeder neue Prefix setzt den Cache zurück.
- ACE (arXiv 2510.04618): „context collapse“ durch wiederholtes Umschreiben.
- Eine gemessene Studie „N-mal kompaktieren vs. neu anlegen“ gibt es nicht.

Empfehlung (hybrid):
- Mitten in einem Arbeitspaket: vor dem Abkühlen warm kompaktieren, weil das Arbeitsdetail erhalten bleibt.
- An Paketgrenzen (CHECKPOINT gilt, keine laufenden Worker), nach 2 Kompaktierungen oder bei einer Basis über ~60k nach dem Compact: neu anlegen plus Brief.
- Kalter Kontext: nie kompaktieren, immer neu anlegen plus Brief.
- Folge für Auto-Cleanup: Es muss nur kompaktieren, wenn das Paket offen ist. Sonst darf der Agent kalt werden, das kostet nichts, und beim Resume wird neu angelegt.

Lücken in der Implementierung (TODO):
1. `fresh` geht nur für den aktiven Steer. Für nicht aktive Steers und Worker fehlt der Weg.
2. `agent run` aus einem Agenten setzt automatisch `paseo.parent-agent-id`. Fresh muss die Verknüpfung lösen bzw. ohne Parent anlegen (siehe executor).
3. Nach einer manuellen Neuanlage hängt im Worker-Register von Steer E der Eintrag 8f8dd781 „agent not live · supervised running“. Er muss bereinigt werden; Zustandsdateien nicht direkt ändern.
4. Zwei lebende Agenten im Slot B, bis der alte archiviert ist.
5. Der Slot-B-Profilname nennt muse, B läuft aber auf codex (bestehende Warnung).

## Nachtrag: Erneuern im selben Tab per Rewind (live verifiziert, 2026-11-24)
Nutzerwunsch: Ein Steer soll erneuert werden können, und der Tab bleibt an derselben Position. Neuer Tab plus alten löschen ist dafür nicht nötig.

Nativer Weg: Paseo-Rewind. Die DaemonClient-Methode lautet `rewindAgent(agentId, messageId, "conversation")`.
- Als messageId die erste `user_message` aus `fetchAgentTimeline(id, {limit: 0, projection: "canonical"})` nehmen. Danach den Resume-Brief per send nachschicken.
- Codex forkt den Thread vor diesem Turn. Agent-ID, Tab, Labels und Position bleiben erhalten, der alte Codex-Thread bleibt auf der Platte (`codex resume`).
- Messung an Steer B 86fdb7f3: vorher 31k Kontext. Nach Rewind plus Brief 21,7k Input, davon 14k gecacht, also 7,7k ungecacht. Das Modell erinnert sich an keine früheren Aufgaben.
- Grenzen:
  - Die High-Level-SDK (`createPaseoClient`) bietet keinen Rewind. Nötig ist der DaemonClient aus `@getpaseo/client/dist/daemon-client.js`; besser upstream eine `ref.rewind` anfragen bzw. beitragen.
  - Agent-Nachrichten (`paseo send`) erscheinen in der Timeline als `tool_call` ohne messageId. Ein Agent, der nur per send bedient wurde, hat deshalb keinen Rewind-Punkt. Zur Not muss er dann neu angelegt werden.
  - Der Verlauf im Tab wird ersetzt (Nutzer: alter Chat nicht mehr sichtbar, „ist dann eben so“).
- Testskript: /tmp/codexres/rewind.mjs.
- Aufgeräumt: Test-Tab 8f8dd781 archiviert. Im Worker-Register von E steht er noch als „agent not live · supervised running“; das bitte über die Factory bereinigen.

Empfehlung für die Implementierung: `fresh` und Auto-Cleanup für Codex (und andere Provider ohne natives /clear) per Rewind auf die erste Nachricht plus Brief umsetzen, für alle Steers und Worker. Neuanlage plus Archivieren nur als Fallback, wenn kein Rewind-Punkt existiert. Die Tab-Position ist im Client nur über die UI-Befehle „Move tab“ änderbar, eine API dafür gibt es nicht. Das spricht zusätzlich für Rewind.

## Nachtrag 2: Wiederholbares Rewind und neue TODO (Nutzer, 2026-11-24)
- Live: Steer B wurde zweimal zurückgespult; das zweite Mal auf eine Brief-Nachricht. Danach 22,1k Input, davon 14k gecacht. Die Einschränkung (kein Rewind-Punkt) hat der Nutzer akzeptiert.
- Wichtig: Nur echte `user_message`-Einträge sind Rewind-Punkte. Wer aus einem Agenten heraus mit `paseo send` schickt (PASEO_AGENT_ID gesetzt), erzeugt `tool_call paseo-agent-message:…`, und Rewind darauf scheitert („could not find user message“). Die Factory muss den Resume-Brief deshalb so zustellen, dass er als `user_message` ankommt (SDK ohne Caller-Agent). Für die nächste Erneuerung wird genau auf diesen Brief zurückgespult; alles davor bleibt.
- Bei B bleibt vor dem Brief ein kleiner Testwechsel (~0,5k) stehen. Das ist ohne Bedeutung.

TODO (Nutzer): Option „Historie früherer Agents im Tab behalten“, Standard **an**.
- Aus: Mit jeder Erneuerung wird der Chatverlauf gelöscht; der Nutzer sieht nur, was der Agent auch weiß. Das ist das heutige Rewind-Verhalten.
- An: Der Verlauf soll sichtbar bleiben, obwohl der Agent-Kontext neu ist. Den Mechanismus muss die Umsetzung klären. Mögliche Ansätze:
  - Paseo-Timeline-Ersatz beim Rewind vermeiden oder unterdrücken, ggf. ein Upstream-Feature „rewind/fork ohne Timeline-Ersatz“ bzw. Kontext-Reset mit sichtbarer Historie.
  - Alten Verlauf per Plugin-Timeline-Render oder Anhang einblenden (die Plugin-API kann Timeline-Items rendern bzw. anhängen).
  - Alten Codex-Thread über `paseo agent import` bzw. `factory.history.open` verlinken.
  Zuerst die nativen Wege prüfen.
