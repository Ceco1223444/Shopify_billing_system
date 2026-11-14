/**
 * The call recommendation (P5-15, P5-20): a short Bulgarian script with 1–2 questions, and for an
 * error the Google Maps and Google search LINKS for the address (plain URLs a person opens; no
 * Google service is called by the app).
 */
import type { DeliveryDecision } from './decide.ts';
import type { DetectionInput } from './signals.ts';

const CARRIER_BG = { econt: 'Еконт', speedy: 'Спиди' } as const;

export function addressText(input: DetectionInput): string {
  return [
    input.address1,
    input.address2,
    [input.zip, input.city].filter(Boolean).join(' '),
    'България',
  ]
    .map((p) => (p ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}

export function addressLinks(input: DetectionInput): { maps: string; search: string } {
  const q = encodeURIComponent(addressText(input));
  return {
    maps: `https://www.google.com/maps/search/?api=1&query=${q}`,
    search: `https://www.google.com/search?q=${q}`,
  };
}

/**
 * "Здравейте, обаждам се от HappyHome за поръчка #2008. Къде да изпратим пратката — до офис на
 * Спиди <име> или до личен адрес?" Always Bulgarian: it is what the person says to the customer.
 */
export function callScript(
  decision: DeliveryDecision,
  orderRefs: string,
  options: { shopName?: string; address?: string } = {},
): string {
  const shop = options.shopName ?? 'HappyHome';
  const hello = `Здравейте, обаждам се от ${shop} за поръчка ${orderRefs}.`;
  const s = decision.suggestion;
  const pointOf = (p: NonNullable<typeof s>) =>
    `${p.type === 'locker' ? 'автомат' : 'офис'} на ${CARRIER_BG[p.carrier]} „${p.name_bg}“`;

  if (decision.rule === 'F') {
    const code = decision.reasons[0]?.code;
    if (code === 'other_courier') {
      return `${hello} Изпращаме само с Еконт и Спиди. До кой офис или автомат на Еконт или Спиди да изпратим пратката, или до личен адрес?`;
    }
    return `${hello} Можете ли да ми кажете точния адрес за доставка: град, улица и номер? Удобен ли ви е офис на Еконт или Спиди наблизо?`;
  }
  if (decision.deliveryType === 'address' && !s) {
    const where = options.address ? `: ${options.address}` : '';
    return `${hello} Да изпратим ли пратката до вашия адрес${where}? Или предпочитате офис или автомат на Еконт или Спиди?`;
  }
  if (s) {
    return `${hello} Къде да изпратим пратката — до ${pointOf(s)} или до личен адрес?`;
  }
  const carrier = decision.carrier ? ` на ${CARRIER_BG[decision.carrier]}` : '';
  return `${hello} До кой офис или автомат${carrier} да изпратим пратката, или до личен адрес?`;
}
