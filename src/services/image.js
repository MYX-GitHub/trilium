"use strict";

const repository = require('./repository');
const log = require('./log');
const protectedSessionService = require('./protected_session');
const noteService = require('./notes');
const optionService = require('./options');
const imagemin = require('imagemin');
const imageminMozJpeg = require('imagemin-mozjpeg');
const imageminPngQuant = require('imagemin-pngquant');
const imageminGifLossy = require('imagemin-giflossy');
const jimp = require('jimp');
const imageType = require('image-type');
const sanitizeFilename = require('sanitize-filename');
const dateUtils = require('./date_utils');
const NoteRevision = require("../entities/note_revision");

async function processImage(uploadBuffer, originalName, shrinkImageSwitch) {
    const origImageFormat = imageType(uploadBuffer);

    if (origImageFormat.ext === "webp") {
        // JIMP does not support webp at the moment: https://github.com/oliver-moran/jimp/issues/144
        shrinkImageSwitch = false;
    }

    const finalImageBuffer = shrinkImageSwitch ? await shrinkImage(uploadBuffer, originalName) : uploadBuffer;

    const imageFormat = imageType(finalImageBuffer);

    return {
        buffer: finalImageBuffer,
        imageFormat
    };
}

async function updateImage(noteId, uploadBuffer, originalName) {
    const {buffer, imageFormat} = await processImage(uploadBuffer, originalName, true);

    const note = await repository.getNote(noteId);

    const noteRevision = await new NoteRevision({
        noteId: note.noteId,
        // title and text should be decrypted now
        title: note.title,
        contentLength: -1, // will be updated in .setContent()
        type: note.type,
        mime: note.mime,
        isProtected: false, // will be fixed in the protectNoteRevisions() call
        utcDateLastEdited: note.utcDateModified,
        utcDateCreated: dateUtils.utcNowDateTime(),
        utcDateModified: dateUtils.utcNowDateTime(),
        dateLastEdited: note.dateModified,
        dateCreated: dateUtils.localNowDateTime()
    }).save();

    await noteRevision.setContent(await note.getContent());

    note.mime = 'image/' + imageFormat.ext.toLowerCase();

    await note.setContent(buffer);

    await note.setLabel('originalFileName', originalName);
    await note.setLabel('fileSize', buffer.byteLength);

    await noteService.protectNoteRevisions(note);
}

async function saveImage(parentNoteId, uploadBuffer, originalName, shrinkImageSwitch) {
    const {buffer, imageFormat} = await processImage(uploadBuffer, originalName, shrinkImageSwitch);

    const fileName = sanitizeFilename(originalName);

    const parentNote = await repository.getNote(parentNoteId);

    const {note} = await noteService.createNote(parentNoteId, fileName, buffer, {
        target: 'into',
        type: 'image',
        isProtected: parentNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
        mime: 'image/' + imageFormat.ext.toLowerCase(),
        attributes: [
            { type: 'label', name: 'originalFileName', value: originalName },
            { type: 'label', name: 'fileSize', value: buffer.byteLength }
        ]
    });

    return {
        fileName,
        note,
        noteId: note.noteId,
        url: `api/images/${note.noteId}/${fileName}`
    };
}

async function shrinkImage(buffer, originalName) {
    const resizedImage = await resize(buffer);
    let finalImageBuffer;

    try {
        finalImageBuffer = await optimize(resizedImage);
    } catch (e) {
        log.error("Failed to optimize image '" + originalName + "'\nStack: " + e.stack);
        finalImageBuffer = resizedImage;
    }

    // if resizing & shrinking did not help with size then save the original
    // (can happen when e.g. resizing PNG into JPEG)
    if (finalImageBuffer.byteLength >= buffer.byteLength) {
        finalImageBuffer = buffer;
    }

    return finalImageBuffer;
}

async function resize(buffer) {
    const imageMaxWidthHeight = await optionService.getOptionInt('imageMaxWidthHeight');

    const image = await jimp.read(buffer);

    if (image.bitmap.width > image.bitmap.height && image.bitmap.width > imageMaxWidthHeight) {
        image.resize(imageMaxWidthHeight, jimp.AUTO);
    }
    else if (image.bitmap.height > imageMaxWidthHeight) {
        image.resize(jimp.AUTO, imageMaxWidthHeight);
    }

    // we do resizing with max quality which will be trimmed during optimization step next
    image.quality(100);

    // when converting PNG to JPG we lose alpha channel, this is replaced by white to match Trilium white background
    image.background(0xFFFFFFFF);

    return image.getBufferAsync(jimp.MIME_JPEG);
}

async function optimize(buffer) {
    return await imagemin.buffer(buffer, {
        plugins: [
            imageminMozJpeg({
                quality: await optionService.getOptionInt('imageJpegQuality')
            }),
            imageminPngQuant({
                quality: [0, 0.7]
            }),
            imageminGifLossy({
                lossy: 80,
                optimize: '3' // needs to be string
            })
        ]
    });
}

module.exports = {
    saveImage,
    updateImage
};