import Pikaday from 'pikaday';
import { DateFormat } from 'util/formatting/date-format';
import { Locale } from 'util/locale';
import { FieldViewText } from 'views/fields/field-view-text';

class FieldViewDate extends FieldViewText {
    hasOptions = false;

    renderValue(value) {
        let result = value ? DateFormat.dStr(value) : '';
        if (value && this.model.lessThanNow && value < new Date()) {
            result += ' ' + this.model.lessThanNow;
        }
        return result;
    }

    getEditValue(value) {
        return value ? DateFormat.dStr(value) : '';
    }

    startEdit() {
        super.startEdit();
        this.picker = new Pikaday({
            field: this.input[0],
            onSelect: this.pickerSelect.bind(this),
            onClose: this.pickerClose.bind(this),
            defaultDate: this.value,
            minDate: new Date(),
            firstDay: 1,
            i18n: {
                previousMonth: '',
                nextMonth: '',
                months: Locale.months,
                weekdays: Locale.weekdays,
                weekdaysShort: Locale.weekdaysShort
            }
        });
        this.picker.adjustPosition = this.adjustPickerPosition.bind(this);
        setTimeout(() => this.picker.show(), 0);
    }

    adjustPickerPosition(...args) {
        window.Pikaday = Pikaday;
        Pikaday.prototype.adjustPosition.apply(this.picker, args);
        const shadowSpread = parseInt(this.input.css('--focus-shadow-spread'));
        if (shadowSpread) {
            const isOnTop = this.picker.el.classList.contains('top-aligned');
            const offset = isOnTop ? -shadowSpread : shadowSpread;
            const newTop = parseInt(this.picker.el.style.top) + offset;
            this.picker.el.style.top = `${newTop}px`;
        }
    }

    fieldValueBlur(e) {
        if (!this.picker) {
            super.fieldValueBlur(e);
        }
    }

    endEdit(newVal, extra) {
        if (this.picker) {
            try {
                this.picker.destroy();
            } catch (e) {}
            this.picker = null;
        }
        newVal = new Date(newVal);
        if (!newVal || isNaN(newVal.getTime())) {
            newVal = null;
        }
        super.endEdit(newVal, extra);
    }

    pickerClose() {
        this.endEdit(this.input.val());
    }

    pickerSelect(dt) {
        this.endEdit(dt);
    }
}

export { FieldViewDate };
