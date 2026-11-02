# IIIF Book Downloader

A Tampermonkey userscript that downloads page images of digitised books and manuscripts from any library that publishes them through **IIIF**, the open standard used by many libraries, museums and archives.

Pick the whole book or a custom page range, and it saves each page as a full-resolution JPEG, with live progress.

## Features

- **Works with any IIIF source.** Supports both IIIF Presentation API versions (v2 and v3).
- **Finds the manifest automatically** when a page links to one. Otherwise you paste the manifest URL from the Tampermonkey menu.
- **Recursive manifest parsing.** Walks the manifest's nested structure to collect every page in reading order, skipping thumbnails and logos.
- **Page ranges.** Download the whole book, or ranges like `1-10, 15, 20-25`.
- **Asynchronous downloads** one page at a time, with a short pause between requests so library servers aren't overloaded, and progress shown on the button.

## How it works

1. A IIIF **manifest** is a JSON file describing a digitised object: its title, its pages, and an **image service** for each page.
2. The script walks the manifest recursively and records each image service. Page images sit at different depths in v2 manifests (`sequences → canvases → images → resource → service`) and v3 manifests (`items → items → items → body → service`), so a recursive walk handles both without separate code paths.
3. For each selected page, it asks the image service for the largest size available. That's `full/max/0/default.jpg` for Image API 3 and `full/full/0/default.jpg` for version 2.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `iiif-book-downloader.user.js` in this repository and click **Raw**. Tampermonkey will offer to install it.
3. On a library page with a IIIF viewer, click **📥 Download book (IIIF)**. Or open the Tampermonkey menu and choose **Download from a IIIF manifest…**.

By default the script is available on every site, but it only shows its button when it finds a manifest. To limit it to one library, change the `@match` line to that library's address.

## Use it responsibly

Only download material you're allowed to, and check each library's terms of use and the rights statement on each item. Many digitised collections are public domain or openly licensed, but not all.

## Built with

JavaScript, the IIIF Presentation and Image APIs, and the Tampermonkey `GM_xmlhttpRequest` and `GM_download` APIs.

## License

MIT
