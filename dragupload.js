Hooks.once('init', async () => {
    const usingTheForge = typeof ForgeVTT != "undefined" && ForgeVTT.usingTheForge;

    game.settings.register("dragupload", "fileUploadSource", {
        name: "The path files should be uploaded to",
        scope: "world",
        config: !usingTheForge,
        type: String,
        default: usingTheForge ? "forgevtt" : "data",
        choices: {
            "data": game.i18n.localize("FILES.SourceUser"),
            "s3": game.i18n.localize("FILES.SourceS3"),
        },
        onChange: async () => { await initializeDragUpload(); }
    });

    game.settings.register("dragupload", "fileUploadFolder", {
        name: "The path files should be uploaded to",
        hint: "Should look like 'dragupload/uploaded'",
        scope: "world",
        config: true,
        type: String,
        default: "dragupload/uploaded",
        onChange: async () => { await initializeDragUpload(); }
    });

    try {
        const buckets = await FilePicker.browse("s3", "");
        let bucketChoices = {};
        for ( let bucket of buckets.dirs ) {
            bucketChoices[bucket] = bucket;
        }
        game.settings.register("dragupload", "fileUploadBucket", {
            name: "If using S3, what S3 bucket should be used",
            scope: "world",
            config: !usingTheForge,
            type: String,
            default: usingTheForge ? "" : (FilePicker.S3_BUCKETS?.length > 0 ? FilePicker.S3_BUCKETS[0] : ""),
            choices: bucketChoices,
            onChange: async () => {
                await initializeDragUpload();
            }
        });
    }
    catch {}
});

Hooks.once('ready', async function() {
    await initializeDragUpload();

    new DragDrop({
        callbacks: {
            drop: handleDrop
        }
    })
    .bind(document.getElementById("board"));
});

async function initializeDragUpload() {
    if (game.user.isGM || game.user.hasPermission(CONST.USER_PERMISSIONS.FILES_UPLOAD)) {
        await createFoldersIfMissing();
    }

    let folderParts = [];
    const targetFolder = game.settings.get("dragupload", "fileUploadFolder");
    folderParts = folderParts.concat(targetFolder.split("/")).filter(x => x !== "");

    window.dragUpload = {};
    window.dragUpload.targetFolder = folderParts.join("/");
}

async function createFoldersIfMissing() {
    const targetLocation = game.settings.get("dragupload", "fileUploadFolder");
    const targetLocationFolders = targetLocation.split("/").filter(x => x !== "");
    let pathParts = [];
    for ( const folder of targetLocationFolders ) {
        pathParts.push(folder);
        await createFolderIfMissing(pathParts.join("/"));
    }
    await createFolderIfMissing(pathParts.concat("tokens").join("/"));
    await createFolderIfMissing(pathParts.concat("tiles").join("/"));
    await createFolderIfMissing(pathParts.concat("ambient").join("/"));
    await createFolderIfMissing(pathParts.concat("journals").join("/"));
}

async function createFolderIfMissing(folderPath) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    try {
        let result = await FilePicker.browse(source, folderPath);
        if ( !result.dir.includes(folderPath) ) await FilePicker.createDirectory(source, folderPath, source === "s3" ? { bucket: game.settings.get("dragupload", "fileUploadBucket") } : {});
    }
    catch (error) {
        try {
            await FilePicker.createDirectory(source, folderPath, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
        }
        catch {}
    }
}

async function handleDrop(event) {
    event.preventDefault();

    const files = event.dataTransfer.files;
    let file;
    if (!files || files.length === 0) {
        let url = event.dataTransfer.getData("Text");
        if (!url) {
            canvas._onDrop(event);
            return;
        }
        if (url.includes("?")) url = url.substr(0, url.indexOf("?"));
        const splitUrl = url.split("/");
        let filename = splitUrl[splitUrl.length - 1];
        if (!filename.includes(".")) {
            canvas._onDrop(event);
            return;
        }
        const extension = filename.substr(filename.lastIndexOf(".") + 1);
        const validExtensions = Object.keys(CONST.IMAGE_FILE_EXTENSIONS)
            .concat(Object.keys(CONST.VIDEO_FILE_EXTENSIONS))
            .concat(Object.keys(CONST.AUDIO_FILE_EXTENSIONS));
        if (!validExtensions.includes(extension)) {
            canvas._onDrop(event);
            return;
        }
        if (url.includes("imgur") && filename.endsWith("_d.webp")) {
            filename = filename.substr(0, filename.length - "_d.webp".length) + ".png";
            url = url.substr(0, url.length - "_d.webp".length) + ".png";
        }
        file = {isExternalUrl: true, url: url, name: filename};
    } else {
        file = files[0];
    }

    if (file == undefined) {
        canvas._onDrop(event);
        return;
    }

    if (Object.keys(CONST.AUDIO_FILE_EXTENSIONS).filter(x => x != "webm" && file.name.endsWith(x)).length > 0) {
        await HandleAudioFile(event, file);
        return;
    }

    const layer = canvas.activeLayer?.constructor.name || "";

    if (layer.includes("ForegroundLayer")) {
        await CreateTile(event, file, true);
    } else if (layer.includes("TokenLayer")) {
        await CreateActor(event, file);
    } else if (layer.includes("NotesLayer")) {
        await CreateJournalPin(event, file);
    } else {
        await CreateTile(event, file, false);
    }
}

async function HandleAudioFile(event, file) {
    await CreateAmbientAudio(event, file);
}

async function CreateAmbientAudio(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response;
    if (file.isExternalUrl) {
        response = {path: file.url};
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/ambient", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }

    const data = {
        t: "l",
        path: response.path,
        radius: 10,
        easing: true,
        repeat: true,
        volume: 1.0
    };

    convertXYtoCanvas(data, event);
    canvas.sounds.activate();
    await canvas.scene.createEmbeddedDocuments("AmbientSound", [data]);
}

async function CreateTile(event, file, overhead) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response;
    if (file.isExternalUrl) {
        response = {path: file.url};
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/tiles", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }

    const data = CreateImgData(event, response);
    const tex = await loadTexture(data.img);
    const ratio = canvas.dimensions.size / (data.tileSize || canvas.dimensions.size);
    
    data.texture = { src: data.img };
    // Updated for PIXI v7/v8 texture property handling
    data.width = (tex.width || tex.baseTexture?.width || 100) * ratio;
    data.height = (tex.height || tex.baseTexture?.height || 100) * ratio;
    data.overhead = overhead;

    data.x = data.x - (data.width / 2);
    data.y = data.y - (data.height / 2);
    if ( !event.shiftKey ) foundry.utils.mergeObject(data, canvas.grid.getSnappedPosition(data.x, data.y, 1));

    if ( event.altKey ) data.hidden = true;

    canvas.tiles.activate();
    return canvas.scene.createEmbeddedDocuments('Tile', [data], {});
}

async function CreateJournalPin(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response;
    if (file.isExternalUrl) {
        response = {path: file.url};
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/journals", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }

    const data = {
        name: file.name,
        img: response.path
    };

    const journal = await JournalEntry.create(data);
    const pinData = {
        entryId: journal.id,
        icon: "icons/svg/book.svg",
        iconSize: 40,
        text: "",
        fontSize: 48,
        textAnchor: CONST.TEXT_ANCHOR_POINTS.CENTER
    };

    convertXYtoCanvas(pinData, event);
    canvas.notes.activate();
    return canvas.scene.createEmbeddedDocuments('Note', [pinData], {});
}

async function CreateActor(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response;
    if (file.isExternalUrl) {
        response = {path: file.url};
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/tokens", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }

    const data = CreateImgData(event, response);
    data.name = file.name;
    const tokenData = CreateImgData(event, response);

    if (Object.keys(CONST.IMAGE_FILE_EXTENSIONS).filter(x => file.name.endsWith(x)).length == 0) {
        data.img = "";
    }

    if ( !game.user.can("TOKEN_CREATE") ) {
        return ui.notifications.warn(`You do not have permission to create new Tokens!`);
    }

    const types = Object.keys(CONFIG.Actor.sheetClasses);
    types.push("actorless");

    if (types.length > 1) {
        let d = new Dialog({
            title: "What Type should this Actor be created as?",
            buttons: {},
            default: types[0],
            close: () => {}
        });

        types.forEach(x => {
            d.data.buttons[x] = {
                label: x,
                callback: async () => await CreateActorWithType(event, data, tokenData, x)
            };
        });

        d.render(true);
    } else {
        await CreateActorWithType(event, data, tokenData, types[0]);
    }
}

async function CreateActorWithType(event, data, tokenImageData, type) {
    let createdType = type;
    if (type === "actorless") {
        createdType = Object.keys(CONFIG.Actor.sheetClasses)[0];
    }

    let actorName = data.name;
    if (actorName.includes(".")) {
        actorName = actorName.split(".")[0];
    }

    const actor = await getDocumentClass("Actor").create({
        name: actorName,
        type: createdType,
        img: data.img
    });

    const prototypeToken = actor.prototypeToken;
    const actorId = actor._id;

    const hg = canvas.dimensions.size / 2;
    data.x -= (prototypeToken.width * hg);
    data.y -= (prototypeToken.height * hg);

    let tokenData = { x: data.x, y: data.y, hidden: event.altKey, img: tokenImageData.img };

    if ( !event.shiftKey ) foundry.utils.mergeObject(tokenData, canvas.grid.getSnappedPosition(data.x, data.y, 1));
    
    const d = canvas.dimensions;
    tokenData.x = Math.clamped(tokenData.x, 0, d.width-1);
    tokenData.y = Math.clamped(tokenData.y, 0, d.height-1);

    if ( prototypeToken.randomImg ) {
        let images = await actor.getTokenImages();
        images = images.filter(i => (images.length === 1) || !(i === this._lastWildcard));
        const image = images[Math.floor(Math.random() * images.length)];
        tokenData.img = this._lastWildcard = image;
    }

    tokenData = foundry.utils.mergeObject(foundry.utils.duplicate(prototypeToken), tokenData, {inplace: true});
    tokenData.actorId = actorId;
    tokenData.actorLink = true;

    canvas.tokens.activate();
    await canvas.scene.createEmbeddedDocuments('Token', [tokenData], {});

    if (type === "actorless") {
        actor.delete();
    }
}

function CreateImgData(event, response) {
    const data = {
        img: response.path
    };
    convertXYtoCanvas(data, event);
    return data;
}

function convertXYtoCanvas(data, event) {
    const [x, y] = [event.clientX, event.clientY];
    const t = canvas.stage.worldTransform;
    data.x = (x - t.tx) / canvas.stage.scale.x;
    data.y = (y - t.ty) / canvas.stage.scale.y;

    Hooks.callAll("dragDropPositioning", { event: event, data: data });
}
