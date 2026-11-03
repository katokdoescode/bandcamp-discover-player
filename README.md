# Discover Player for Bandcamp

Браузерное расширение для Firefox и Chrome: проигрывает всю выдачу страницы
`bandcamp.com/discover/...` — по порядку или шаффлом, по одному треку с релиза
или релизы целиком. Плеер открывается по клику на иконку расширения и выглядит
как плеер на странице релиза Bandcamp.

> Неофициальное расширение, не связано с Bandcamp. Использует внутренние API,
> которыми пользуются страницы самого Bandcamp; если они изменятся, расширение
> может перестать работать.

## Возможности

- **play this page** — играет ровно те релизы, что показаны на открытой discover-странице
  (включая подгруженные кнопкой «View more results»), дальше сам догружает следующие.
- **one track per release** / **full releases** — один трек с релиза или релиз целиком.
- **shuffle** — перемешивает релизы, треки внутри релиза идут по порядку.
- После перезагрузки страницы (у `s=rand` выдача каждый раз новая) или смены фильтров
  предлагает **update list**; текущий трек доигрывает.
- ♡ wishlist для релизов и отдельных треков (красное — уже в вишлисте, повторный клик убирает).
  Нужна открытая вкладка bandcamp.com с вашим логином; если её нет — предложит войти.
- Музыка играет после закрытия окошка. Медиа-клавиши, в окошке — `Space`, `Shift+←/→`.

## Разработка

Нужен Node.js 22+.

```bash
npm install
```

```bash
npm run dev            # Chrome с расширением и живой перезагрузкой
```

```bash
npm run dev:firefox    # то же для Firefox
```

```bash
npm run check          # типы, тесты, обе сборки, линтер Mozilla — то же, что CI
```

Сборки появляются в `.output/chrome-mv3` и `.output/firefox-mv2`; `npm run zip` и
`npm run zip:firefox` упаковывают их для магазинов (для Firefox ещё и архив исходников).

Установить сборку вручную:
- **Chrome:** `chrome://extensions` → режим разработчика → «Загрузить распакованное» → `.output/chrome-mv3`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → «Load Temporary Add-on…» → `.output/firefox-mv2/manifest.json`.

## Как устроено

Сделано на [WXT](https://wxt.dev) и TypeScript. Почти весь код общий; браузеры
отличаются тем, где живёт плеер и как читается выдача страницы.

| | Firefox (MV2) | Chrome (MV3) |
|---|---|---|
| Где играет звук | постоянная фоновая страница | offscreen-документ; service worker только пересылает сообщения |
| Как видна выдача страницы | `webRequest.filterResponseData` | обёртка `fetch` в контексте страницы (`world: "MAIN"`) |
| Запросы от имени страницы | `content.fetch` | обычный `fetch` из content script |

Chrome закрывает offscreen-документ примерно через 30 секунд тишины, поэтому
состояние плеера сохраняется в `storage.session` и восстанавливается при следующем запуске.

```
src/
  entrypoints/
    background.ts            фон: хост плеера в Firefox, service worker в Chrome
    offscreen/               Chrome: документ со звуком и плеером
    bandcamp.content.ts      данные страницы, запросы от её имени, вишлист
    discover-hook.content.ts Chrome: перехват выдачи страницы
    popup/                   интерфейс
  lib/
    player.ts                очередь, режимы, шаффл, догрузка, вишлист
    hosts/                   платформенные части плеера
    discover-spec.ts         фильтры discover-страницы из URL
    captures.ts              сборка выдачи страницы из её ответов
    bandcamp.ts, page.ts     API Bandcamp и работа со страницей
tests/                       Vitest
```

Используемые эндпоинты Bandcamp:
- `POST /api/discover/1/discover_web` — выдача discover;
- `GET /api/mobile/25/tralbum_details` — трек-лист релиза со ссылками на mp3-128;
- `POST /collect_item_cb`, `/uncollect_item_cb` — вишлист, как кнопка на сайте.

## Релизы

CI (`.github/workflows/ci.yml`) на каждый push в `main` и pull request проверяет
типы, запускает тесты, собирает обе версии и прогоняет линтер Mozilla.

После зелёной проверки на `main` автоматически создаётся GitHub Release с
архивами для Chrome и Firefox (и исходниками для AMO) — если версии из
`package.json` ещё нет среди релизов. Чтобы выпустить новую версию:

```bash
npm version patch      # или minor / major — меняет версию в package.json
```

```bash
git push --follow-tags
```

Архивы из релиза загружаются в Chrome Web Store и на addons.mozilla.org.
Firefox устанавливает только подписанные Mozilla расширения, поэтому zip из
релиза — это то, что отправляется на подпись, а не файл для прямой установки.

## Конфиденциальность

Расширение ничего не собирает и никуда не отправляет, кроме запросов к Bandcamp.
Подробнее — [PRIVACY.md](PRIVACY.md).
