# Структуры свойств для комплектующих ПК

Подготовлено 2026-10-17 для восьми категорий, в которых до этого не было активных
правил. Это требования внутреннего каталога; они не объявлены требованиями GMC.
Все новые правила рекомендательные, а `required_for_selection=false`: владелец ещё
не назначал свойства обязательными для подбора ПК. Существующие свойства SSD (ID 458)
оставлены без изменений.

Просмотренные официальные спецификации, по 2–3 примера на категорию:

- Материнские платы: [ASUS PRIME B650M-A](https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-b650m-a/techspec/) и [MSI PRO B650M-A WIFI](https://tw.msi.com/Motherboard/PRO-B650M-A-WIFI/Specification). Общие поля: сокет, чипсет, форм-фактор, память, слоты и хранилище. Число слотов, предел памяти и режим PCIe могут зависеть от процессора.
- Видеокарты: [ASUS Dual RTX 5060 OC](https://www.asus.com/uk/motherboards-components/graphics-cards/dual/dual-rtx5060-o8g/techspec/) и [MSI RTX 5060 Gaming OC](https://us.msi.com/Graphics-Card/GeForce-RTX-5060-8G-GAMING-OC/Specification). Выделены VRAM, шина, интерфейс, длина/толщина, мощность и разъёмы. «Рекомендуемая мощность БП» хранится отдельно от собственного потребления GPU.
- HDD 3.5: [Seagate BarraCuda 3.5](https://www.seagate.com/support/internal-hard-drives/desktop-hard-drives/barracuda-3-5/), [Toshiba P300](https://www.toshiba-storage.com/products/p300-desktop-pc-hard-drive-2025/) и [WD Blue Desktop](https://www.wd.com/content/store/en-us/products/internal-drives/wd-blue-desktop-sata-hdd.html). Модель влияет на обороты, кэш и CMR/SMR; нельзя переносить характеристику серии на каждый артикул.
- Блоки питания: [Corsair RM750x](https://www.corsair.com/us/en/p/psu/cp-9020179-na/rmx-series-rm750x-750-watt-80-plus-gold-certified-fully-modular-psu-cp-9020179-na), [Seasonic FOCUS GX](https://seasonic.com/focus-gx/) и [be quiet! Pure Power 12 M](https://www.bequiet.com/en/powersupply/4073). Вынесены мощность, форм-фактор, сертификация, модульность, стандарт ATX и типы кабелей.
- Корпуса: [Fractal Design North XL](https://www.fractal-design.com/products/cases/north-series/north-xl/north-xl-rc-charcoal-black-tg-dark/), [Cooler Master MasterBox Q300L](https://www.coolermaster.com/en-sg/products/masterbox-q300l-white.html) и [Montech AIR 903 MAX](https://www.montechpc.com/air-903-max). Поля для формата плат, габаритов компонентов, отсеков и радиаторов. Пределы длины GPU/БП зависят от корзин и радиаторов.
- Кулеры для процессоров: [Noctua NH-D15 G2 HBC](https://www.noctua.at/en/products/nh-d15-g2-hbc/specifications), [DeepCool AK620](https://www.deepcool.com/products/Cooling/cpuaircoolers/AK620-High-Performance-CPU-Cooler-1700-AM5/2021/13067.shtml) и [Thermalright Peerless Assassin 120 SE](https://www.thermalright.com/product/peerless-assassin-120-se/). Собраны сокеты, высота, тип кулера, вентиляторы и габариты. Совместимость определять по точной ревизии/креплению.
- СЖО: [ARCTIC Liquid Freezer III 360](https://www.arctic.de/en/Liquid-Freezer-III-360) и [Corsair iCUE H150i Elite Capellix XT](https://www.corsair.com/ww/en/p/cpu-coolers/cw-9060070-ww/icue-h150i-elite-capellix-xt-liquid-cpu-cooler). Поля для сокетов, размера и физических размеров радиатора, блока, вентиляторов и длины трубок.
- Охлаждение корпусов: [Noctua NF-A12x25 PWM](https://www.noctua.at/en/products/nf-a12x25-pwm/specifications) и [ARCTIC P12 PWM PST](https://www.arctic.de/en/P12-PWM-PST/). Поля для размера, RPM, воздушного потока, статического давления, шума, разъёма и подсветки.

Коды выбраны с учётом общих семантик, чтобы повторное использование `capacity`,
`storage_interface`, `storage_form_factor`, `storage_connection` и `memory_type`
не создавало разные типы или единицы. SSD уже использует тот же шаблон накопителя
на уровне этих четырёх полей. Свойства радиаторов СЖО и пределы корпусов остаются
разными: это характеристики разных изделий.

Добавление шаблона только задаёт схему карточки. Оно не заполняет значения в тысячах
товаров и не утверждает, что все характеристики доступны для каждой модели. Для этого
нужна следующая работа по сбору достоверных спецификаций и источников.
