# DBD Surv Trainer

App desktop non ufficiale per allenarsi lato survivor in Dead by Daylight — timer 1v1 con overlay in game, callout orari per le mappe, moonwalk trainer e altro.

Non è affiliata con, approvata da, o collegata a Behaviour Interactive. Dead by Daylight e tutti i nomi correlati sono marchi di Behaviour Interactive Inc.

## Download

Scarica l'ultima versione dalla pagina **[Releases](../../releases)** di questo repository — prendi il file `DBD Surv Trainer Setup X.X.X.exe` e installalo come qualsiasi altro programma Windows.

Non è firmata digitalmente, quindi Windows potrebbe mostrare un avviso SmartScreen ("Windows ha protetto il PC") al primo avvio dell'installer: clicca **"Ulteriori informazioni"** poi **"Esegui comunque"**.

## Cosa fa

- **Timer 1v1** con scoreboard overlay, sempre in primo piano sopra al gioco, editabile in game
- **Overlay mappe** con callout orari (da [Hens' Callouts](https://hens333.com/callouts), usati con permesso), rilevamento automatico della mappa via OCR
- **Moonwalk trainer** e **vault/pallet timing trainer**
- Hotkey da **tastiera**, **mouse (M1)** e **controller Xbox (XInput)**, tutte riassegnabili liberamente
- Colori, posizione, dimensione e opacità dell'overlay tutti personalizzabili

## Un avviso sulle hotkey Shift / M1

L'app offre, come opzione **facoltativa e disattivata di default**, la possibilità di avviare il timer premendo Shift o il tasto sinistro del mouse (M1), oltre ai normali tasti F1-F12. Per farlo, mentre quell'opzione è attiva, l'app ascolta a livello di sistema la pressione di quei tasti specifici — una tecnica nella stessa categoria di programmi come AutoHotkey, che in alcuni giochi con anti-cheat (incluso, in alcuni contesti, EasyAntiCheat) è stata segnalata come rilevata.

Un altro tool diffuso per Dead by Daylight con una funzione simile (avviare un timer 1v1 con Shift), "DBD 1v1 Timer", ha dichiarato pubblicamente di usare la stessa categoria di tecnica — a conferma che è un approccio non isolato in questo tipo di strumenti, anche se questo non è comunque una garanzia di sicurezza.

**Punti importanti:**
- Questo riguarda **solo** chi attiva esplicitamente l'opzione "Enable a dedicated Crouch/M1 key" e assegna Shift o M1 a un'azione. Se non la attivi, quella parte di codice non si avvia mai sul tuo PC.
- Usando **solo** le hotkey normali (tasti F, riassegnabili liberamente) e il **controller**, questa categoria di rischio non si applica: quelle tecniche funzionano in modo diverso (scorciatoie di sistema standard, o lettura periodica dello stato del controller via XInput, la stessa API usata dai giochi stessi).
- Il rischio concreto non è quantificabile con certezza — potrebbe essere basso in pratica, ma non è possibile escluderlo del tutto.

**Esclusione di responsabilità:** questo software viene fornito "così com'è", senza alcuna garanzia. L'uso della funzione Shift/M1 è una scelta volontaria di chi la attiva. L'autore non si assume alcuna responsabilità per eventuali provvedimenti (ban, sospensioni, o altro) presi dall'anti-cheat o dallo sviluppatore del gioco nei confronti di chi usa questa o qualsiasi altra parte dell'app.

## Segnalare un problema

Se qualcosa non funziona, apri una [Issue](../../issues) su questo repository descrivendo cosa succede — più dettagli dai (screenshot, cosa ti aspettavi, cosa è successo davvero) più è facile risolverlo.

## Crediti

Vedi la sezione Credits dentro l'app stessa per l'elenco completo dei ringraziamenti.

## Per sviluppatori — far girare il codice sorgente

Serve **Node.js** (https://nodejs.org, versione LTS va bene). Dentro questa cartella:

```
npm install
npm start
```

Per creare un installer da zero:

```
npm run dist
```

L'installer finito compare dentro la cartella `dist`.
