import { View } from 'framework/views/view';
import { KeyHandler } from 'comp/browser/key-handler';
import { Keys } from 'const/keys';
import template from 'templates/modal.hbs';

class ModalView extends View {
    parent = 'body';

    template = template;

    events = {
        'click .modal__buttons button': 'buttonClick',
        'click': 'bodyClick'
    };

    constructor(model) {
        super(model);
        if (typeof this.model.esc === 'string') {
            this.onKey(Keys.DOM_VK_ESCAPE, this.escPressed, false, 'alert');
        }
        if (typeof this.model.enter === 'string') {
            this.onKey(Keys.DOM_VK_RETURN, this.enterPressed, false, 'alert');
        }
        KeyHandler.setModal('alert');
        this.once('remove', () => {
            KeyHandler.setModal(null);
            if (this.model.view) {
                this.model.view.remove();
            }
        });
    }

    render() {
        super.render(this.model);
        this.$el.addClass('modal--hidden');
        setTimeout(() => {
            this.$el.removeClass('modal--hidden');
            document.activeElement.blur();
        }, 20);
        if (this.model.view) {
            this.model.view.parent = '.modal__body';
            this.model.view.render();
        }
    }

    change(config) {
        if (config.header) {
            this.$el.find('.modal__header').html(config.header);
        }
    }

    buttonClick(e) {
        const result = $(e.target).data('result');
        this.closeWithResult(result);
    }

    bodyClick() {
        if (typeof this.model.click === 'string') {
            this.closeWithResult(this.model.click);
        }
    }

    escPressed() {
        this.closeWithResult(this.model.esc);
    }

    enterPressed(e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.closeWithResult(this.model.enter);
    }

    closeWithResult(result) {
        const checked = this.model.checkbox
            ? this.$el.find('#modal__check').is(':checked')
            : undefined;
        this.emit('result', result, checked);
        this.$el.addClass('modal--hidden');
        this.unbindEvents();
        setTimeout(() => this.remove(), 100);
    }

    closeImmediate() {
        this.emit('result', undefined);
        this.unbindEvents();
        this.remove();
    }
}

export { ModalView };
