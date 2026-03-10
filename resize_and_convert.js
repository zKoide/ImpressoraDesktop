const jimpInfo = require('jimp');
const Jimp = jimpInfo.Jimp || jimpInfo;
const pngToIco = require('png-to-ico');
const fs = require('fs');

async function processIcon() {
    try {
        const image = await Jimp.read('assets/favicon.png');

        // Support different Jimp versions
        if (typeof image.resize === 'function') {
            try {
                image.resize(256, 256);
            } catch (e) {
                image.resize({ w: 256, h: 256 });
            }
        }

        let buffer;
        if (typeof image.getBufferAsync === 'function') {
            buffer = await image.getBufferAsync(Jimp.MIME_PNG || 'image/png');
        } else if (typeof image.getBuffer === 'function') {
            buffer = await image.getBuffer('image/png');
        }

        fs.writeFileSync('assets/favicon_resized.png', buffer);

        const icoBuffer = await pngToIco('assets/favicon_resized.png');
        fs.writeFileSync('assets/favicon.ico', icoBuffer);

        console.log('Conversion successful!');
    } catch (err) {
        console.error('Error during conversion:', err);
    }
}

processIcon();
