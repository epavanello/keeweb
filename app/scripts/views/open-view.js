import kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Storage } from 'storage';
import { DropboxChooser } from 'comp/app/dropbox-chooser';
import { FocusDetector } from 'comp/browser/focus-detector';
import { KeyHandler } from 'comp/browser/key-handler';
import { SecureInput } from 'comp/browser/secure-input';
import { Launcher } from 'comp/launcher';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { Comparators } from 'util/data/comparators';
import { Features } from 'util/features';
import { UrlFormat } from 'util/formatting/url-format';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';
import { InputFx } from 'util/ui/input-fx';
import { OpenConfigView } from 'views/open-config-view';
import { StorageFileListView } from 'views/storage-file-list-view';
import { escape, omit } from 'util/fn';
import template from 'templates/open.hbs';

const logger = new Logger('open-view');

class OpenView extends View {
    parent = '.app__body';

    template = template;

    events = {
        'change .open__file-ctrl': 'fileSelected',
        'click .open__icon-open': 'openFile',
        'click .open__icon-new': 'createNew',
        'click .open__icon-demo': 'createDemo',
        'click .open__icon-more': 'toggleMore',
        'click .open__icon-storage': 'openStorage',
        'click .open__icon-settings': 'openSettings',
        'click .open__pass-input[readonly]': 'openFile',
        'input .open__pass-input': 'inputInput',
        'keydown .open__pass-input': 'inputKeydown',
        'keyup .open__pass-input': 'inputKeyup',
        'keypress .open__pass-input': 'inputKeypress',
        'click .open__pass-enter-btn': 'openDb',
        'click .open__settings-key-file': 'openKeyFile',
        'click .open__last-item': 'openLast',
        dragover: 'dragover',
        dragleave: 'dragleave',
        drop: 'drop'
    };

    params = null;

    passwordInput = null;

    busy = false;

    currentSelectedIndex = -1;

    constructor(model) {
        super(model);
        this.resetParams();
        this.passwordInput = new SecureInput();
        this.onKey(Keys.DOM_VK_Z, this.undoKeyPress, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_TAB, this.tabKeyPress);
        this.onKey(Keys.DOM_VK_ENTER, this.enterKeyPress);
        this.onKey(Keys.DOM_VK_RETURN, this.enterKeyPress);
        this.onKey(Keys.DOM_VK_DOWN, this.moveOpenFileSelectionDown);
        this.onKey(Keys.DOM_VK_UP, this.moveOpenFileSelectionUp);
        this.listenTo(Events, 'main-window-focus', this.windowFocused.bind(this));
        this.once('remove', () => {
            this.passwordInput.reset();
        });
    }

    render() {
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        const storageProviders = [];
        Object.keys(Storage).forEach(name => {
            const prv = Storage[name];
            if (!prv.system && prv.enabled) {
                storageProviders.push(prv);
            }
        });
        storageProviders.sort((x, y) => (x.uipos || Infinity) - (y.uipos || Infinity));
        const showMore = storageProviders.length || this.model.settings.canOpenSettings;
        const showLogo =
            !showMore &&
            !this.model.settings.canOpen &&
            !this.model.settings.canCreate &&
            !(this.model.settings.canOpenDemo && !this.model.settings.demoOpened);
        super.render({
            lastOpenFiles: this.getLastOpenFiles(),
            canOpenKeyFromDropbox: !Launcher && Storage.dropbox.enabled,
            demoOpened: this.model.settings.demoOpened,
            storageProviders,
            canOpen: this.model.settings.canOpen,
            canOpenDemo: this.model.settings.canOpenDemo,
            canOpenSettings: this.model.settings.canOpenSettings,
            canCreate: this.model.settings.canCreate,
            canRemoveLatest: this.model.settings.canRemoveLatest,
            showMore,
            showLogo
        });
        this.inputEl = this.$el.find('.open__pass-input');
        this.passwordInput.setElement(this.inputEl);
    }

    resetParams() {
        this.params = {
            id: null,
            name: '',
            storage: null,
            path: null,
            keyFileName: null,
            keyFileData: null,
            keyFilePath: null,
            fileData: null,
            rev: null
        };
    }

    windowFocused() {
        this.inputEl.focus();
    }

    focusInput(focusOnMobile) {
        if (FocusDetector.hasFocus() && (focusOnMobile || !Features.isMobile)) {
            this.inputEl.focus();
        }
    }

    getLastOpenFiles() {
        return this.model.fileInfos.map(fileInfo => {
            let icon = 'file-text';
            const storage = Storage[fileInfo.storage];
            if (storage && storage.icon) {
                icon = storage.icon;
            }
            if (storage && storage.iconSvg) {
                icon = null;
            }
            return {
                id: fileInfo.id,
                name: fileInfo.name,
                path: this.getDisplayedPath(fileInfo),
                icon,
                iconSvg: storage ? storage.iconSvg : undefined
            };
        });
    }

    getDisplayedPath(fileInfo) {
        const storage = fileInfo.storage;
        if (storage === 'file' || storage === 'webdav') {
            return fileInfo.path;
        }
        return null;
    }

    showLocalFileAlert() {
        if (this.model.settings.skipOpenLocalWarn) {
            return;
        }
        Alerts.alert({
            header: Locale.openLocalFile,
            body: Locale.openLocalFileBody,
            icon: 'file-text',
            buttons: [
                { result: 'skip', title: Locale.openLocalFileDontShow, error: true },
                { result: 'ok', title: Locale.alertOk }
            ],
            click: '',
            esc: '',
            enter: '',
            success: res => {
                this.focusInput();
                if (res === 'skip') {
                    this.model.settings.skipOpenLocalWarn = true;
                }
            }
        });
    }

    fileSelected(e) {
        const file = e.target.files[0];
        if (file) {
            this.processFile(file, success => {
                if (success && !file.path && this.reading === 'fileData') {
                    this.showLocalFileAlert();
                }
            });
        }
    }

    processFile(file, complete) {
        const reader = new FileReader();
        reader.onload = e => {
            let success = false;
            switch (this.reading) {
                case 'fileData': {
                    const format = this.getOpenFileFormat(e.target.result);
                    switch (format) {
                        case 'kdbx':
                            this.params.id = null;
                            this.params.fileData = e.target.result;
                            this.params.name = file.name.replace(/(.+)\.\w+$/i, '$1');
                            this.params.path = file.path || null;
                            this.params.storage = file.path ? 'file' : null;
                            this.params.rev = null;
                            if (!this.params.keyFileData) {
                                this.params.keyFileName = null;
                            }
                            this.displayOpenFile();
                            this.displayOpenKeyFile();
                            success = true;
                            break;
                        case 'xml':
                            this.params.id = null;
                            this.params.fileXml = kdbxweb.ByteUtils.bytesToString(e.target.result);
                            this.params.name = file.name.replace(/\.\w+$/i, '');
                            this.params.path = null;
                            this.params.storage = null;
                            this.params.rev = null;
                            this.importDbWithXml();
                            success = true;
                            break;
                        case 'kdb':
                            Alerts.error({
                                header: Locale.openWrongFile,
                                body: Locale.openKdbFileBody
                            });
                            break;
                        default:
                            Alerts.error({
                                header: Locale.openWrongFile,
                                body: Locale.openWrongFileBody
                            });
                            break;
                    }
                    break;
                }
                case 'keyFileData':
                    this.params.keyFileData = e.target.result;
                    this.params.keyFileName = file.name;
                    if (this.model.settings.rememberKeyFiles === 'path') {
                        this.params.keyFilePath = file.path;
                    }
                    this.displayOpenKeyFile();
                    success = true;
                    break;
            }
            if (complete) {
                complete(success);
            }
        };
        reader.onerror = () => {
            Alerts.error({ header: Locale.openFailedRead });
            if (complete) {
                complete(false);
            }
        };
        if (this.reading === 'fileXml') {
            reader.readAsText(file);
        } else {
            reader.readAsArrayBuffer(file);
        }
    }

    getOpenFileFormat(fileData) {
        if (fileData.byteLength < 8) {
            return undefined;
        }
        const fileSig = new Uint32Array(fileData, 0, 2);
        if (fileSig[0] === kdbxweb.Consts.Signatures.FileMagic) {
            if (fileSig[1] === kdbxweb.Consts.Signatures.Sig2Kdb) {
                return 'kdb';
            } else if (fileSig[1] === kdbxweb.Consts.Signatures.Sig2Kdbx) {
                return 'kdbx';
            } else {
                return undefined;
            }
        } else if (this.model.settings.canImportXml) {
            try {
                const str = kdbxweb.ByteUtils.bytesToString(fileSig).trim();
                if (str.startsWith('<?xml')) {
                    return 'xml';
                }
            } catch (e) {}
            return undefined;
        } else {
            return undefined;
        }
    }

    displayOpenFile() {
        this.$el.addClass('open--file');
        this.$el.find('.open__settings-key-file').removeClass('hide');
        this.inputEl[0].removeAttribute('readonly');
        this.inputEl[0].setAttribute('placeholder', Locale.openPassFor + ' ' + this.params.name);
        this.focusInput();
    }

    displayOpenKeyFile() {
        this.$el.toggleClass('open--key-file', !!this.params.keyFileName);
        this.$el
            .find('.open__settings-key-file-name')
            .text(this.params.keyFileName || this.params.keyFilePath || Locale.openKeyFile);
        this.focusInput();
    }

    setFile(file, keyFile, fileReadyCallback) {
        this.reading = 'fileData';
        this.processFile(file, success => {
            if (success && keyFile) {
                this.reading = 'keyFileData';
                this.processFile(keyFile);
            }
            if (success && typeof fileReadyCallback === 'function') {
                fileReadyCallback();
            }
        });
    }

    openFile() {
        if (this.model.settings.canOpen === false) {
            return;
        }
        if (!this.busy) {
            this.closeConfig();
            this.openAny('fileData');
        }
    }

    openKeyFile(e) {
        if ($(e.target).hasClass('open__settings-key-file-dropbox')) {
            this.openKeyFileFromDropbox();
        } else if (!this.busy && this.params.name) {
            if (this.params.keyFileName) {
                this.params.keyFileData = null;
                this.params.keyFilePath = null;
                this.params.keyFileName = '';
                this.$el.removeClass('open--key-file');
                this.$el.find('.open__settings-key-file-name').text(Locale.openKeyFile);
            } else {
                this.openAny('keyFileData');
            }
        }
    }

    openKeyFileFromDropbox() {
        if (!this.busy) {
            new DropboxChooser((err, res) => {
                if (err) {
                    return;
                }
                this.params.keyFileData = res.data;
                this.params.keyFileName = res.name;
                this.displayOpenKeyFile();
            }).choose();
        }
    }

    openAny(reading, ext) {
        this.reading = reading;
        this.params[reading] = null;

        const fileInput = this.$el
            .find('.open__file-ctrl')
            .attr('accept', ext || '')
            .val(null);

        if (Launcher && Launcher.openFileChooser) {
            Launcher.openFileChooser((err, file) => {
                if (err) {
                    logger.error('Error opening file chooser', err);
                } else {
                    this.processFile(file);
                }
            });
        } else {
            fileInput.click();
        }
    }

    openLast(e) {
        if (this.busy) {
            return;
        }
        const id = $(e.target)
            .closest('.open__last-item')
            .data('id')
            .toString();
        if ($(e.target).is('.open__last-item-icon-del')) {
            const fileInfo = this.model.fileInfos.get(id);
            if (!fileInfo.storage || fileInfo.modified) {
                Alerts.yesno({
                    header: Locale.openRemoveLastQuestion,
                    body: fileInfo.modified
                        ? Locale.openRemoveLastQuestionModBody
                        : Locale.openRemoveLastQuestionBody,
                    buttons: [
                        { result: 'yes', title: Locale.alertYes },
                        { result: '', title: Locale.alertNo }
                    ],
                    success: () => {
                        this.removeFile(id);
                    }
                });
                return;
            }
            this.removeFile(id);
            return;
        }

        const fileInfo = this.model.fileInfos.get(id);
        this.showOpenFileInfo(fileInfo, true);
    }

    removeFile(id) {
        this.model.removeFileInfo(id);
        this.$el.find('.open__last-item[data-id="' + id + '"]').remove();
        this.resetParams();
        this.render();
    }

    inputKeydown(e) {
        const code = e.keyCode || e.which;
        if (code === Keys.DOM_VK_RETURN) {
            this.openDb();
        } else if (code === Keys.DOM_VK_CAPS_LOCK) {
            this.toggleCapsLockWarning(false);
        }
    }

    inputKeyup(e) {
        const code = e.keyCode || e.which;
        if (code === Keys.DOM_VK_CAPS_LOCK) {
            this.toggleCapsLockWarning(false);
        }
    }

    inputKeypress(e) {
        const charCode = e.keyCode || e.which;
        const ch = String.fromCharCode(charCode);
        const lower = ch.toLowerCase();
        const upper = ch.toUpperCase();
        if (lower !== upper && !e.shiftKey) {
            this.toggleCapsLockWarning(ch !== lower);
        }
    }

    toggleCapsLockWarning(on) {
        this.$el.find('.open__pass-warning').toggleClass('invisible', !on);
    }

    dragover(e) {
        if (this.model.settings.canOpen === false) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const dt = e.dataTransfer;
        if (
            !dt.types ||
            (dt.types.indexOf ? dt.types.indexOf('Files') === -1 : !dt.types.contains('Files'))
        ) {
            dt.dropEffect = 'none';
            return;
        }
        dt.dropEffect = 'copy';
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        if (!this.$el.hasClass('open--drag')) {
            this.$el.addClass('open--drag');
        }
    }

    dragleave() {
        if (this.model.settings.canOpen === false) {
            return;
        }
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.dragTimeout = setTimeout(() => {
            this.$el.removeClass('open--drag');
        }, 100);
    }

    drop(e) {
        if (this.model.settings.canOpen === false) {
            return;
        }
        e.preventDefault();
        if (this.busy) {
            return;
        }
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.closeConfig();
        this.$el.removeClass('open--drag');
        const files = [...(e.target.files || e.dataTransfer.files)];
        const dataFile = files.find(file => /\.kdbx$/i.test(file.name));
        const keyFile = files.find(file => /\.key$/i.test(file.name));
        if (dataFile) {
            this.setFile(
                dataFile,
                keyFile,
                dataFile.path ? null : this.showLocalFileAlert.bind(this)
            );
            return;
        }
        if (this.model.settings.canImportXml) {
            const xmlFile = files.find(file => /\.xml$/i.test(file.name));
            if (xmlFile) {
                this.setFile(xmlFile, null, this.showLocalFileAlert.bind(this));
                return;
            }
        }
        if (this.model.settings.canImportCsv) {
            const csvFile = files.find(file => /\.csv$/i.test(file.name));
            if (csvFile) {
                Events.emit('import-csv-requested', csvFile);
            }
        }
    }

    undoKeyPress(e) {
        e.preventDefault();
    }

    tabKeyPress() {
        this.$el.addClass('open--show-focus');
    }

    enterKeyPress(e) {
        const el = this.$el.find('[tabindex]:focus');
        if (el.length) {
            el.trigger('click', e);
        }
    }

    showOpenFileInfo(fileInfo, fileWasClicked) {
        if (this.busy || !fileInfo) {
            return;
        }
        this.params.id = fileInfo.id;
        this.params.storage = fileInfo.storage;
        this.params.path = fileInfo.path;
        this.params.name = fileInfo.name;
        this.params.fileData = null;
        this.params.rev = null;
        this.params.keyFileName = fileInfo.keyFileName;
        this.params.keyFilePath = fileInfo.keyFilePath;
        this.params.keyFileData = null;
        this.displayOpenFile();
        this.displayOpenKeyFile();

        this.openFileWithFingerprint(fileInfo);

        if (fileWasClicked) {
            this.focusInput(true);
        }
    }

    showOpenLocalFile(path, keyFilePath) {
        if (this.busy) {
            return;
        }
        this.params.id = null;
        this.params.storage = 'file';
        this.params.path = path;
        this.params.name = path.match(/[^/\\]*$/)[0];
        this.params.rev = null;
        this.params.fileData = null;
        this.displayOpenFile();
        if (keyFilePath) {
            const parsed = Launcher.parsePath(keyFilePath);
            this.params.keyFileName = parsed.file;
            this.params.keyFilePath = keyFilePath;
            this.params.keyFileData = null;
            this.displayOpenKeyFile();
        }
    }

    openFileWithFingerprint(fileInfo) {
        if (!fileInfo.fingerprint) {
            return;
        }

        if (Launcher && Launcher.fingerprints) {
            Launcher.fingerprints.auth(fileInfo.id, fileInfo.fingerprint, password => {
                this.inputEl.val(password);
                this.inputEl.trigger('input');
                this.openDb();
            });
        }
    }

    createDemo() {
        if (!this.busy) {
            this.closeConfig();
            if (!this.model.createDemoFile()) {
                this.emit('close');
            }
            if (!this.model.settings.demoOpened) {
                this.model.settings.demoOpened = true;
            }
        }
    }

    createNew() {
        if (!this.busy) {
            this.model.createNewFile();
        }
    }

    openDb() {
        if (this.params.id && this.model.files.get(this.params.id)) {
            this.emit('close');
            return;
        }
        if (this.busy || !this.params.name) {
            return;
        }
        this.$el.toggleClass('open--opening', true);
        this.inputEl.attr('disabled', 'disabled');
        this.busy = true;
        this.params.password = this.passwordInput.value;
        this.afterPaint(() => {
            this.model.openFile(this.params, err => this.openDbComplete(err));
        });
    }

    openDbComplete(err) {
        this.busy = false;
        this.$el.toggleClass('open--opening', false);
        this.inputEl.removeAttr('disabled').toggleClass('input--error', !!err);
        if (err) {
            logger.error('Error opening file', err);
            this.focusInput(true);
            this.inputEl[0].selectionStart = 0;
            this.inputEl[0].selectionEnd = this.inputEl.val().length;
            if (err.code === 'InvalidKey') {
                InputFx.shake(this.inputEl);
            } else {
                if (err.notFound) {
                    err = Locale.openErrorFileNotFound;
                }
                Alerts.error({
                    header: Locale.openError,
                    body:
                        Locale.openErrorDescription +
                        '<pre class="modal__pre">' +
                        escape(err.toString()) +
                        '</pre>'
                });
            }
        } else {
            this.emit('close');
        }
    }

    importDbWithXml() {
        if (this.busy || !this.params.name) {
            return;
        }
        this.$el.toggleClass('open--opening', true);
        this.inputEl.attr('disabled', 'disabled');
        this.busy = true;
        this.afterPaint(() =>
            this.model.importFileWithXml(this.params, err => {
                if (err) {
                    this.params.name = '';
                    this.params.fileXml = null;
                }
                this.openDbComplete(err);
            })
        );
    }

    toggleMore() {
        if (this.busy) {
            return;
        }
        this.closeConfig();
        this.$el.find('.open__icons--lower').toggleClass('hide');
    }

    openSettings() {
        Events.emit('toggle-settings');
    }

    openStorage(e) {
        if (this.busy) {
            return;
        }
        const storage =
            Storage[
                $(e.target)
                    .closest('.open__icon')
                    .data('storage')
            ];
        if (!storage) {
            return;
        }
        if (storage.needShowOpenConfig && storage.needShowOpenConfig()) {
            this.showConfig(storage);
        } else if (storage.list) {
            this.listStorage(storage);
        } else {
            Alerts.notImplemented();
        }
    }

    listStorage(storage, config) {
        if (this.busy) {
            return;
        }
        this.closeConfig();
        const icon = this.$el.find('.open__icon-storage[data-storage=' + storage.name + ']');
        this.busy = true;
        icon.toggleClass('flip3d', true);
        storage.list(config && config.dir, (err, files) => {
            icon.toggleClass('flip3d', false);
            this.busy = false;
            if (err || !files) {
                err = err ? err.toString() : '';
                if (err.lastIndexOf('OAuth', 0) !== 0 && !Alerts.alertDisplayed) {
                    Alerts.error({
                        header: Locale.openError,
                        body:
                            Locale.openListErrorBody +
                            '<pre class="modal__pre">' +
                            escape(err.toString()) +
                            '</pre>'
                    });
                }
                return;
            }
            if (!files.length) {
                Alerts.error({
                    header: Locale.openNothingFound,
                    body: Locale.openNothingFoundBody
                });
                return;
            }

            const fileNameComparator = Comparators.stringComparator('path', true);
            files.sort((x, y) => {
                if (x.dir !== y.dir) {
                    return !!y.dir - !!x.dir;
                }
                return fileNameComparator(x, y);
            });
            if (config && config.dir) {
                files.unshift({
                    path: config.prevDir,
                    name: '..',
                    dir: true
                });
            }
            const listView = new StorageFileListView({
                files,
                showHiddenFiles: config && config.showHiddenFiles
            });
            listView.on('selected', file => {
                if (file.dir) {
                    this.listStorage(storage, {
                        dir: file.path,
                        prevDir: (config && config.dir) || '',
                        showHiddenFiles: true
                    });
                } else {
                    this.openStorageFile(storage, file);
                }
            });
            Alerts.alert({
                header: Locale.openSelectFile,
                body: Locale.openSelectFileBody,
                icon: storage.icon || 'files-o',
                buttons: [{ result: '', title: Locale.alertCancel }],
                esc: '',
                click: '',
                view: listView
            });
        });
    }

    openStorageFile(storage, file) {
        if (this.busy) {
            return;
        }
        this.params.id = null;
        this.params.storage = storage.name;
        this.params.path = file.path;
        this.params.name = UrlFormat.getDataFileName(file.name);
        this.params.rev = file.rev;
        this.params.fileData = null;
        this.displayOpenFile();
    }

    showConfig(storage) {
        if (this.busy) {
            return;
        }
        if (this.views.openConfig) {
            this.views.openConfig.remove();
        }
        const config = {
            id: storage.name,
            name: Locale[storage.name] || storage.name,
            icon: storage.icon,
            buttons: true,
            ...storage.getOpenConfig()
        };
        this.views.openConfig = new OpenConfigView(config, {
            parent: '.open__config-wrap'
        });
        this.views.openConfig.on('cancel', this.closeConfig.bind(this));
        this.views.openConfig.on('apply', this.applyConfig.bind(this));
        this.views.openConfig.render();
        this.$el.find('.open__pass-area').addClass('hide');
        this.$el.find('.open__icons--lower').addClass('hide');
    }

    closeConfig() {
        if (this.busy) {
            this.storageWaitId = null;
            this.busy = false;
        }
        if (this.views.openConfig) {
            this.views.openConfig.remove();
            delete this.views.openConfig;
        }
        this.$el.find('.open__pass-area').removeClass('hide');
        this.$el.find('.open__config').addClass('hide');
        this.focusInput();
    }

    applyConfig(config) {
        if (this.busy || !config) {
            return;
        }
        this.busy = true;
        this.views.openConfig.setDisabled(true);
        const storage = Storage[config.storage];
        this.storageWaitId = Math.random();
        const path = config.path;
        const opts = omit(config, ['path', 'storage']);
        const req = {
            waitId: this.storageWaitId,
            storage: config.storage,
            path,
            opts
        };
        if (storage.applyConfig) {
            storage.applyConfig(opts, this.storageApplyConfigComplete.bind(this, req));
        } else {
            storage.stat(path, opts, this.storageStatComplete.bind(this, req));
        }
    }

    storageApplyConfigComplete(req, err) {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        if (err) {
            this.views.openConfig.setDisabled(false);
            this.views.openConfig.setError(err);
        } else {
            this.closeConfig();
        }
    }

    storageStatComplete(req, err, stat) {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        if (err) {
            this.views.openConfig.setDisabled(false);
            this.views.openConfig.setError(err);
        } else {
            this.closeConfig();
            this.params.id = null;
            this.params.storage = req.storage;
            this.params.path = req.path;
            this.params.opts = req.opts;
            this.params.name = UrlFormat.getDataFileName(req.path);
            this.params.rev = stat.rev;
            this.params.fileData = null;
            this.displayOpenFile();
        }
    }

    moveOpenFileSelection(steps) {
        const lastOpenFiles = this.getLastOpenFiles();
        if (
            this.currentSelectedIndex + steps >= 0 &&
            this.currentSelectedIndex + steps <= lastOpenFiles.length - 1
        ) {
            this.currentSelectedIndex = this.currentSelectedIndex + steps;
        }

        const lastOpenFile = lastOpenFiles[this.currentSelectedIndex];
        if (!lastOpenFile) {
            return;
        }
        const fileInfo = this.model.fileInfos.get(lastOpenFiles[this.currentSelectedIndex].id);
        this.showOpenFileInfo(fileInfo);

        if (fileInfo && Launcher && Launcher.fingerprints) {
            this.openFileWithFingerprint(fileInfo);
        }
    }

    moveOpenFileSelectionDown() {
        this.moveOpenFileSelection(1);
    }

    moveOpenFileSelectionUp() {
        this.moveOpenFileSelection(-1);
    }
}

export { OpenView };
