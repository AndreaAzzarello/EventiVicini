import { fromData } from './event';

// Gli stessi payload del seed SEED_XSS (web/scripts/seed-emulator.mjs): arrivano da fonti importate, senza passare dalle regole.
const base = { startTime: Date.UTC(2026, 10, 14, 20), endTime: Date.UTC(2026, 10, 14, 22), lat: 44.64, lng: 10.92, city: 'Modena', citySlug: 'modena', province: 'MO' };

export const xssUno = () =>
	fromData('xssUno', {
		...base,
		title: 'Prova <img src=x onerror=alert(1)> </script><script>alert(2)</script>',
		shortDescription: '"><svg onload=alert(3)> <b>grassetto</b> {{7*7}}${7*7}     <!-- fine',
		venueName: '<script>alert(4)</script><img src=x onerror=alert(1)>',
		address: 'Via "Roma" 1, <i>Modena</i> </script><script>alert(2)</script>',
		tags: ['family', '<script>alert(5)</script>'],
		imageUrl: 'javascript:alert(6)',
		ticketUrl: 'javascript:alert(7)',
		sourceUrl: 'javascript:alert(8)'
	});

export const xssDue = () =>
	fromData('xssDue', {
		...base,
		title: 'Titolo\r\nBEGIN:VEVENT\r\nSUMMARY:iniettato\r\nEND:VEVENT',
		shortDescription: 'Riga1\r\nATTENDEE:mailto:x@example.test\\;,;',
		venueName: 'Luogo; con, virgole\\e\nnuova riga',
		address: 'data:text/html,<script>alert(9)</script>',
		imageUrl: 'https://example.org/x.jpg" onerror="alert(10)',
		ticketUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxMSk8L3NjcmlwdD4=',
		sourceUrl: 'https://example.org/a b"><script>alert(12)</script>'
	});
