# Fly Pixel Game 🪰

**▶ Грати: https://fly-brain-game.vercel.app** — у браузері, і на телефоні теж.

> **In English.** A pixel-art fly on a desk whose behaviour is driven by the
> real brain wiring of an adult fruit fly: the full **FlyWire FAFB v783
> connectome (139,255 neurons, 2.7 M synapses)**, simulated as a spiking
> (LIF) network in your browser. Taking off from a threat and landing are
> read from real, identified cells (looming detectors LC4/LPLC2, giant
> fibre DNp01, landing neurons DNp07/DNp10). Where the data can't decide
> yet (body reflexes, eating, steering, sleep), the code and docs say so
> openly. The fly lives on like a tamagotchi while you're away, learns to
> avoid a hot mug, a live wire and a cockroach, and can die and be revived.
> The game UI is in Ukrainian. No build step: `python3 -m http.server`.

## Що це

Піксельна муха на робочому столі. Її поведінкою керує не `Math.random()`,
а справжня схема мозку дорослої дрозофіли — повний конектом **FlyWire
FAFB v783: 139 255 нейронів і 2,7 млн синапсів**, що працює як мережа
спайкових нейронів (LIF) у Web Worker прямо в браузері.

- **Рішення зі справжніх клітин.** Тінь від кліку чи таргана йде в
  детектори наближення LC4/LPLC2. Злетіти командує гігантське волокно
  DNp01, сісти — нейрони посадки DNp07/DNp10 (типи клітин з анотацій
  FlyWire). Шкала страху зчитується з цих нейронів утечі.
- **Чесно про межі.** Де даних бракує — рефлекси тіла від струсу й струму,
  рішення про їжу, напрям руху, сон — це прямо позначено в коді, в
  інтерфейсі й у `HANDOFF.md`, а не видано за «рішення мозку».
- **Навчання.** Муха вчиться уникати гарячу чашку, оголений провід і
  таргана. Подразник справді стимулює клітини Кеньона, а сила асоціації —
  ігрова модель пам'яті (аверсивних MBON/DAN у цьому датасеті немає).
- **Як тамагочі.** Муха зберігається в браузері (`localStorage`) і живе
  далі, поки тебе нема: час відсутності «докручується» в повільному темпі
  (спрага повна приблизно за 2 год) з підсумком «Поки тебе не було…».
  Залишена їжа — турбота: муха з'їсть її сама. Без води ~10 год або без
  їжі ~14 год муха помирає; «Воскресити» починає нове життя. Прихована
  вкладка — пауза, щоб не палити батарею.

## Інтерфейс

- **Сцена** — кімната з мухою на всю висоту, без перекриттів.
- **«Зараз»** — думка мухи й групи нейронів, що саме спрацювали.
- **Мозок наживо** — 3D-карта всіх 139 255 нейронів за справжніми
  координатами FlyWire; спалах — справжній спайк цього нейрона. Можна
  обертати.
- **Тіло і стан** — голод, спрага, витривалість, пил, страх, стрес,
  дофамін, цікавість; вік, перекуси, смерті.
- **Журнал спостережень** — зльоти з причиною, посадки, їжа, удари
  струмом, сон, «запам'ятала/забула», твої дії, смерть.
- **Дії** — Їжа, Труснути, Прибрати, День/Ніч. Ще можна клікнути по мусі
  (тінь-загроза). На кинуту їжу згодом приповзає тарган, а від струсу
  з чашки розхлюпується кава (вода з кофеїном).

На телефоні думка закріплена згори, а кнопки — внизу під пальцем.

## Запуск локально

`file://` не працює (браузер блокує `fetch` і `Worker`, тоді вмикається
лише спрощена резервна модель) — потрібен будь-який статичний HTTP-сервер:

```bash
git clone https://github.com/vitaliidudka/FlyBrainGame.git
cd FlyBrainGame
python3 -m http.server 8791
# → http://localhost:8791/fly-pixel-game.html
```

Без `npm install`, без збірки, без бекенду. Кожен браузер має свою муху.

## Структура

- `fly-pixel-game.html` — гра, інтерфейс, тіло й поведінка (спрайти
  вшиті base64).
- `js/sim-worker.js` — симуляція LIF-мережі у Web Worker.
- `js/brain-worker-bridge.js` — міст: стимули в мозок, спайки й моторні
  виходи назад у гру.
- `data/` — конектом (`connectome.bin.gz`, 12 МБ), координати нейронів,
  метадані груп, `neuron_types.json` (справжні типи клітин).
- `scripts/build_neuron_types.py` — як зібрано `neuron_types.json` з
  анотацій FlyWire.
- `assets/` — вихідні спрайт-аркуші й карта зон (для редагування; у грі
  вже вшиті).
- `design/` — референсний макет інтерфейсу.
- `HANDOFF.md` — архітектура, стан, рішення й відкриті питання. Почни
  звідси, якщо продовжуєш роботу.
- `CHANGELOG.md` — хронологія розробки.

Деплой: Vercel бере кожен push у `main`; `vercel.json` веде `/` на
`fly-pixel-game.html`.

## Дані та подяки

- Конектом і типи клітин — **FlyWire, FAFB v783**, ліцензія
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) (з
  посиланням на джерело, лише некомерційно):
  - Dorkenwald S. et al. *Neuronal wiring diagram of an adult brain.*
    Nature 634, 124–138 (2024).
  - Schlegel P. et al. *Whole-brain annotation and multi-connectome cell
    typing of Drosophila.* Nature 634, 139–152 (2024).
- LIF-симуляція, міст і підготовлені файли конектома —
  [snedea/flybrain](https://github.com/snedea/flybrain) (MIT).

## Ліцензія

Код — MIT (див. `LICENSE`). Дані FlyWire — CC BY-NC 4.0, на них MIT не
поширюється.
