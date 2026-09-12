/**
 * Svelte action: constrain an <input> to a valid money value as the user types.
 * Digits and a single decimal point, at most two fraction digits. Pairs with
 * server-side Money.fromDecimal — this is field-level polish, not the guard.
 */

/**
 * The field's one reading of an amount string. When the value arrived via
 * paste or drop, comma markers get the benefit of the doubt: the last of , or
 * . is the decimal ("1.234,56", "1,234.56") and a lone comma with a one- or
 * two-digit tail is decimal too ("12,50") — while "1,234" reads as grouping.
 * Typed input keeps the old behavior (anything but digits and dots stripped)
 * so nobody composing a grouping separator mid-flight fights the field.
 */
export function normalizeMoneyInput(raw: string, pasted: boolean): string {
	let v = raw;
	const lastComma = v.lastIndexOf(',');
	const lastDot = v.lastIndexOf('.');
	if (pasted && lastComma !== -1 && lastDot !== -1) {
		v = lastComma > lastDot ? v.replaceAll('.', '').replace(',', '.') : v.replaceAll(',', '');
	} else if (pasted && lastComma !== -1 && v.indexOf(',') === lastComma) {
		const tail = v.slice(lastComma + 1);
		if (/^\d{1,2}$/.test(tail)) v = v.slice(0, lastComma) + '.' + tail;
	}
	v = v.replace(/[^0-9.]/g, '');
	const dot = v.indexOf('.');
	if (dot !== -1) {
		// keep the first dot, drop the rest, cap at two decimals
		v =
			v.slice(0, dot + 1) +
			v
				.slice(dot + 1)
				.replace(/\./g, '')
				.slice(0, 2);
	}
	return v;
}

export function money(node: HTMLInputElement) {
	function clean(event: Event) {
		const pasted = ((event as InputEvent).inputType ?? '').startsWith('insertFrom');
		const start = node.selectionStart;
		const v = normalizeMoneyInput(node.value, pasted);
		if (v !== node.value) {
			const delta = node.value.length - v.length;
			node.value = v;
			if (start !== null) node.setSelectionRange(start - delta, start - delta);
			node.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}
	node.addEventListener('input', clean);
	return {
		destroy() {
			node.removeEventListener('input', clean);
		}
	};
}
