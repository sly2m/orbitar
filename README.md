## Orbitar

Прототип коллективного блога.

**ДИСКЛЕЙМЕР**: целью было быстро сделать прототип. Писалось всё быстро и на коленке, код дурно пахнет и на 100% подлежит переписыванию.

## Разработка
В hosts добавить:
```
127.0.0.1 orbitar.local api.orbitar.local

# Можно дополнить списком подсайтов по вкусу
127.0.0.1 idiod.orbitar.local

# Да, надо сделать нормальный конфиг для бэка, но пока так
127.0.0.1 mysql
```
В файле `.env` можно изменить имя хоста, если `orbitar.local` вдруг не подходит.

### Запуск для отладки
Запуск контейнера с базой и веб-роутером:
```
docker-compose -p orbitar-dev -f docker-compose.dev.yml up
```
mysql повиснет на стандартном 3306 порту

Веб-роутер на 80 порту - будет перенаправлять запросы с `*.orbitar.local` на `localhost:5000` (фронт), а `api.orbitar.local` на `localhost:5001` (бэк).

Фронт в режиме отслеживания изменений и бэк запускаются стандартно: `npm run start`.

После первого запуска можно открыть приглашение http://orbitar.local/invite/initial и зарегистрировать первый юзернейм.

### Запуск полностью в контейнере (локально)
```
# Пересборка фронта и бэка
docker-compose -p orbitar -f docker-compose.local.yml --no-cache build
# Запуск
docker-compose -p orbitar -f docker-compose.local.yml up
```