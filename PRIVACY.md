# Privacy Policy — Local VOT

*[Русская версия ниже](#политика-конфиденциальности--local-vot)*

Last updated: October 18, 2026

Local VOT is a free, open-source desktop app for Windows that adds a Russian voice-over to video files on your computer
using the Yandex video translation service. The source code is public:
https://github.com/SolidSnake1765/local-vot

**The developer does not run any server and does not receive, collect or store any of your data.** The app runs only
on your computer and talks only to the services listed below, on your behalf.

## What the app does with your files

To get a translation, the app makes a small "light copy" of a video (a black picture plus the video's sound) and
uploads it to **your own** cloud storage — Yandex Disk or Google Drive, whichever you choose — so that the Yandex
translation service can download it by a link. The original video never leaves your computer.

- The copy is placed in a folder created by the app. On Google Drive the app can only see and change the files it
  created itself (the `drive.file` permission); it cannot see any other files on your Drive.
- Only while a video is being translated, its copy is accessible to anyone who has its link (the link is long and
  random and is given only to the Yandex translation service); when the translation is ready, the app closes the link.
  The app deletes the copy when you remove the video from the list or close the app (if you chose to keep the list
  between launches — when the video is removed from the list), and cleans up leftover copies on the next start.
- The finished translation (sound and subtitles) is downloaded from Yandex and saved on your computer.

## Google user data

If you sign in with Google, the app uses the Google Drive API only to upload the light copies, make them accessible by
link, and delete them. It does not read, analyze or share any other data from your Google account, and it does not use
Google user data for advertising or for training AI models. The app's use of information received from Google APIs
adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Sign-in tokens

Sign-in tokens for Yandex and Google are stored only on your computer, in the app's data folder, encrypted with
Windows data protection. Signing out in the app deletes them. You can also revoke the app's access at any time in your
[Google account](https://myaccount.google.com/permissions) or [Yandex ID](https://id.yandex.ru/security).

## Third-party services

Using the app means using these services under their own terms and privacy policies: Yandex (video translation,
Yandex Disk, Yandex ID) and Google (Google Drive, Google sign-in).

## Logs

The app keeps a technical log (file names, sizes, errors) in its data folder on your computer. It is never sent anywhere.

## Contact

Questions: [GitHub issues](https://github.com/SolidSnake1765/local-vot/issues) or localvot@googlegroups.com.

---

# Политика конфиденциальности — Local VOT

Обновлено: 18 октября 2026 г.

Local VOT — бесплатная программа с открытым кодом для Windows: добавляет к видео на вашем компьютере русскую озвучку
через переводчик видео Яндекса. Исходный код: https://github.com/SolidSnake1765/local-vot

**У автора нет сервера, и он не получает, не собирает и не хранит никаких ваших данных.** Программа работает только
на вашем компьютере и обращается от вашего имени только к перечисленным ниже сервисам.

## Что программа делает с файлами

Чтобы получить перевод, программа делает облегчённую копию видео (чёрная картинка и звук видео) и загружает её на
**ваше** облако — Яндекс Диск или Google Диск, что выберете, — чтобы переводчик Яндекса скачал её по ссылке. Само
видео с компьютера никуда не уходит.

- Копия кладётся в папку, созданную программой. На Google Диске программа видит и меняет только созданные ею файлы
  (право `drive.file`), к остальным файлам Диска доступа у неё нет.
- Только пока видео переводится, его копия доступна всем, у кого есть ссылка (длинная и случайная; её получает
  только переводчик Яндекса); когда перевод готов, программа закрывает ссылку. Копию программа удаляет, когда вы
  убираете видео из списка или закрываете программу (если включено «сохранять список между запусками» — когда видео
  убрано из списка), а оставшиеся копии убирает при следующем запуске.
- Готовый перевод (звук и субтитры) скачивается у Яндекса и сохраняется на вашем компьютере.

## Данные Google

Если вы входите через Google, программа использует Google Drive API только чтобы загрузить облегчённые копии,
открыть к ним доступ по ссылке и удалить их. Другие данные вашего аккаунта Google она не читает, не анализирует и
никому не передаёт, не использует их для рекламы или обучения ИИ. Использование данных, полученных через API Google,
соответствует [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
включая требования Limited Use.

## Вход в аккаунты

Ключи входа в Яндекс и Google хранятся только на вашем компьютере, в папке данных программы, зашифрованные средствами
Windows. «Выйти» в программе их удаляет. Доступ программы можно отозвать в любой момент в
[аккаунте Google](https://myaccount.google.com/permissions) или в [Яндекс ID](https://id.yandex.ru/security).

## Сторонние сервисы

Пользуясь программой, вы пользуетесь этими сервисами на их условиях: Яндекс (перевод видео, Яндекс Диск, Яндекс ID) и
Google (Google Диск, вход через Google).

## Журнал

Программа ведёт технический журнал (имена файлов, размеры, ошибки) в своей папке данных на вашем компьютере. Он никуда
не отправляется.

## Связь

Вопросы — в [issues на GitHub](https://github.com/SolidSnake1765/local-vot/issues) или на localvot@googlegroups.com.
