import { parseDay, windowRange, type DateWindow } from './dates';
import { CATEGORIES, compareEvents, isForKids, isFree, type Category, type Event } from './event';
import { DEFAULT_RADIUS_KM, RADII_KM, distanceKm, type LatLng } from './geo';

export interface Filter {
	q: string;
	when: DateWindow;
	/** Solo con when = 'range': "AAAA-MM-GG"; to vuoto = un solo giorno. */
	from: string;
	to: string;
	free: boolean;
	kids: boolean;
	category: Category | null;
	radiusKm: number;
}

export const EMPTY_FILTER: Filter = {
	q: '',
	when: 'any',
	from: '',
	to: '',
	free: false,
	kids: false,
	category: null,
	radiusKm: DEFAULT_RADIUS_KM
};

/** I filtri vivono nell'URL (?q=&quando=oggi|domani|weekend|7giorni&dal=&al=&gratis=1&bambini=1&cat=&r=): condivisibili e SSR. */
const WHEN_PARAM: Record<string, DateWindow> = { oggi: 'today', domani: 'tomorrow', weekend: 'weekend', '7giorni': 'week' };
const WHEN_NAME = Object.fromEntries(Object.entries(WHEN_PARAM).map(([k, v]) => [v, k]));

export function filterFromParams(p: URLSearchParams): Filter {
	const cat = p.get('cat');
	const r = Number(p.get('r'));
	const from = parseDay(p.get('dal') ?? '') ? p.get('dal')! : '';
	const to = from && parseDay(p.get('al') ?? '') ? p.get('al')! : '';
	return {
		q: (p.get('q') ?? '').slice(0, 100),
		// dal/al vincono sui preset relativi
		when: from ? 'range' : (WHEN_PARAM[p.get('quando') ?? ''] ?? 'any'),
		from,
		to: to >= from ? to : '',
		free: p.get('gratis') === '1',
		// i vecchi link con cat=kids passano al filtro rapido, che include la categoria
		kids: p.get('bambini') === '1' || cat === 'kids',
		category: cat && cat !== 'kids' && cat in CATEGORIES ? (cat as Category) : null,
		radiusKm: (RADII_KM as readonly number[]).includes(r) ? r : DEFAULT_RADIUS_KM
	};
}

export function filterToParams(f: Filter): URLSearchParams {
	const p = new URLSearchParams();
	if (f.q.trim()) p.set('q', f.q.trim());
	if (f.when === 'range' && f.from) {
		p.set('dal', f.from);
		if (f.to && f.to !== f.from) p.set('al', f.to);
	} else if (f.when !== 'any' && f.when !== 'range') p.set('quando', WHEN_NAME[f.when]);
	if (f.free) p.set('gratis', '1');
	if (f.kids) p.set('bambini', '1');
	if (f.category) p.set('cat', f.category);
	if (f.radiusKm !== DEFAULT_RADIUS_KM) p.set('r', String(f.radiusKm));
	return p;
}

const norm = (s: string) =>
	s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();

/** Eventi non finiti che passano i filtri, ordinati per inizio. Come EventFilter.apply in Dart. */
export function applyFilter(events: Event[], f: Filter, now: number, origin: LatLng | null): Event[] {
	const range = windowRange(f.when, now, f.from, f.to);
	const q = norm(f.q.trim());
	return events
		.filter((e) => {
			if (e.endTime < now) return false;
			if (range && !(e.startTime < range[1] && e.endTime > range[0])) return false;
			if (f.free && !isFree(e)) return false;
			if (f.kids && !isForKids(e)) return false;
			if (f.category && e.category !== f.category) return false;
			if (q && !norm(`${e.title} ${e.shortDescription} ${e.venueName} ${e.address} ${e.city}`).includes(q))
				return false;
			return !origin || distanceKm(origin, e) <= f.radiusKm;
		})
		.sort(compareEvents(now));
}
