import { describe, it, expect } from 'vitest';
import { describeEvent, deviceLabel, isDeviceMismatch } from './security-log';

const IPHONE_27_0 =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const IPHONE_27_2 =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1';
const MAC_CHROME =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

describe('deviceLabel', () => {
	it('names the device and browser', () => {
		expect(deviceLabel(IPHONE_27_0)).toBe('iPhone · Safari 27.0');
		expect(deviceLabel(MAC_CHROME)).toBe('Mac · Chrome 152');
		expect(deviceLabel(null)).toBe('Unknown device');
	});
});

describe('isDeviceMismatch', () => {
	it('flags a session used from another device', () => {
		expect(isDeviceMismatch(IPHONE_27_0, MAC_CHROME)).toBe(true);
	});

	// The incident this exists for: two iPhones a Safari point-release apart.
	// Coarse device names would have called them the same phone.
	it('tells two iPhones on different Safari versions apart', () => {
		expect(isDeviceMismatch(IPHONE_27_0, IPHONE_27_2)).toBe(true);
	});

	it('does not flag the same device, or a session with no recorded device', () => {
		expect(isDeviceMismatch(IPHONE_27_2, IPHONE_27_2)).toBe(false);
		expect(isDeviceMismatch(IPHONE_27_2, null)).toBe(false);
	});
});

describe('describeEvent', () => {
	it('says when someone changed their own role', () => {
		expect(
			describeEvent({
				action: 'member.role_changed',
				actorName: 'Phil',
				targetName: 'Phil',
				detail: { from: 'owner', to: 'member' }
			})
		).toBe('Phil changed their own role from owner to member');
	});

	it('names both sides of a role change', () => {
		expect(
			describeEvent({
				action: 'member.role_changed',
				actorName: 'Phil',
				targetName: 'Levi Truong',
				detail: { from: 'member', to: 'owner' }
			})
		).toBe('Phil changed Levi Truong from member to owner');
	});

	it('distinguishes a flag toggle from a settings save', () => {
		expect(
			describeEvent({
				action: 'workspace.settings_changed',
				actorName: 'Phil',
				targetName: null,
				detail: { flag: 'bucketChargesSkipApproval', value: true }
			})
		).toBe('Phil turned on bucketChargesSkipApproval');
		expect(
			describeEvent({
				action: 'workspace.settings_changed',
				actorName: 'Phil',
				targetName: null,
				detail: { inviteTtlDays: { from: 7, to: 30 } }
			})
		).toBe('Phil changed inviteTtlDays');
	});
});
