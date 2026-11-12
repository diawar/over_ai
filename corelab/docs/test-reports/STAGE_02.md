# Этап 2 — каркас и вход

Дата: 2026-10-14. Статус: завершён.

## Выполнено

- Docker Desktop 4.95.0 после перезагрузки успешно запустил WSL 2 backend и Linux engine; Compose 5.6.0.
- В `corelab/` создана структура backend (FastAPI, SQLAlchemy, Alembic) и frontend (React, TypeScript, Vite), Compose-файл с PostgreSQL 17, API и UI, healthchecks и постоянным volume.
- Реализованы начальная админ-учётная запись из переменных окружения, Argon2id, подписанная HTTP-only cookie сессии, CSRF-проверка logout/смены пароля, ограничение частоты login, проверка роли admin, первый обязательный пароль при нелокальном старте.
- Создан UI входа и защищённая оболочка `/admin` с двумя разделами «Каталог» и «Журнал». Содержимое разделов пока заглушки — это последующие этапы.
- `corelab/.env` содержит случайный пароль БД и ключ сессии, исключён из Git. Каталог данных PostgreSQL сохраняется в volume `corelab_postgres_data`.

## Тесты и ручная проверка

- `docker compose exec -T backend pytest -q` — **6 passed**, 1 предупреждение совместимости Starlette/AnyIO, exit 0. Использовалась отдельная БД PostgreSQL `corelab_test`, SQLite не применялся.
- `npm run build` — сборка production frontend успешна, exit 0.
- `npm test` — **2 passed**, 1 test file, exit 0.
- `docker compose exec -T backend sh -c 'export DATABASE_URL="${DATABASE_URL%/corelab}/corelab_test"; alembic upgrade head && alembic downgrade base && alembic upgrade head'` — все три миграционных шага успешны, exit 0.
- `docker compose ps` — db, backend и frontend имеют состояние healthy.
- Ручной smoke: вход локального администратора успешен, `/api/v1/admin/auth/me` вернул `diawar86`; `/api/health` и `/admin/login` вернули HTTP 200.

## Команды запуска

Из `corelab/`: `docker compose up -d --build`; остановка с сохранением БД: `docker compose down`. Интерфейс: `http://localhost:5173/admin/login`; API docs: `http://localhost:8000/docs`. При первом старте локальный login `diawar86` / `111` (задано ТЗ). Тестовую БД перед повторным запуском тестов при необходимости создать командой `docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" corelab_test 2>/dev/null || true'`.

## Ограничения и границы

- Каталог, журнал и модель данных каталога ещё не реализованы.
- Не импортировали каталог, не подключались к p1 и не настраивали расписание.
- Этап 3 не начат; дождаться отдельного подтверждения заказчика.
- Mini App, его данные и источник p1 не изменялись.
