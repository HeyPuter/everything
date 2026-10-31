// Built-in starter templates. Names are string keys so they follow the display language.
import { t } from '../../../lib/i18n/index.js';

const STARTERS = Object.freeze([
  { id: 'essentials', kind: 'pack', name: 'lists.starterEssentials', lists: [
    { name: 'lists.catDocuments', items: ['lists.itemPassport', 'lists.itemTickets', 'lists.itemWallet', 'lists.itemInsurance', 'lists.itemKeys'] },
    { name: 'lists.catClothes', items: [{ key: 'lists.itemShirts', qty: 3 }, { key: 'lists.itemUnderwear', qty: 4 }, { key: 'lists.itemSocks', qty: 4 }, 'lists.itemPants', 'lists.itemSleepwear', 'lists.itemJacket'] },
    { name: 'lists.catToiletries', items: ['lists.itemToothbrush', 'lists.itemToothpaste', 'lists.itemDeodorant', 'lists.itemShampoo', 'lists.itemMedication'] },
    { name: 'lists.catElectronics', items: ['lists.itemPhoneCharger', 'lists.itemAdapter', 'lists.itemHeadphones', 'lists.itemPowerBank'] },
  ] },
  { id: 'beach', kind: 'pack', name: 'lists.starterBeach', lists: [
    { name: 'lists.catClothes', items: [{ key: 'lists.itemSwimwear', qty: 2 }, 'lists.itemSandals', 'lists.itemSunHat', 'lists.itemCoverUp'] },
    { name: 'lists.catBeach', items: ['lists.itemSunscreen', 'lists.itemSunglasses', 'lists.itemBeachTowel', 'lists.itemWaterBottle', 'lists.itemBook'] },
  ] },
  { id: 'cold', kind: 'pack', name: 'lists.starterCold', lists: [
    { name: 'lists.catClothes', items: ['lists.itemThermals', 'lists.itemWarmJacket', 'lists.itemGloves', 'lists.itemBeanie', 'lists.itemScarf', { key: 'lists.itemWoolSocks', qty: 3 }, 'lists.itemBoots'] },
    { name: 'lists.catToiletries', items: ['lists.itemLipBalm', 'lists.itemMoisturizer'] },
  ] },
  { id: 'business', kind: 'pack', name: 'lists.starterBusiness', lists: [
    { name: 'lists.catClothes', items: [{ key: 'lists.itemDressShirts', qty: 2 }, 'lists.itemSuit', 'lists.itemDressShoes'] },
    { name: 'lists.catWork', items: ['lists.itemLaptop', 'lists.itemLaptopCharger', 'lists.itemNotebook', 'lists.itemBusinessCards'] },
  ] },
  { id: 'prep', kind: 'todo', name: 'lists.starterPrep', lists: [
    { name: 'lists.catBefore', items: [
      { key: 'lists.todoPassport', prio: 1 }, { key: 'lists.todoInsurance', prio: 1 }, { key: 'lists.todoBank', prio: 2 },
      { key: 'lists.todoCheckIn', prio: 2 }, { key: 'lists.todoOffline', prio: 3 }, { key: 'lists.todoHome', prio: 3 },
    ] },
  ] },
]);

/** Starter templates of one kind, translated: `[{id, kind, name, lists, starter: true}]` (the template store's shape). */
export function starters(kind) {
  return STARTERS.filter((starter) => starter.kind === kind).map((starter) => ({
    id: starter.id, kind, starter: true, name: t(starter.name),
    lists: starter.lists.map((list) => ({
      name: t(list.name),
      items: list.items.map((entry) => {
        const { key, ...rest } = typeof entry === 'string' ? { key: entry } : entry;
        return { name: t(key), ...rest };
      }),
    })),
  }));
}

/** Every string key the starters use, for tests. */
export const starterKeys = () => STARTERS.flatMap((starter) => [starter.name, ...starter.lists.flatMap((list) => [list.name, ...list.items.map((entry) => (typeof entry === 'string' ? entry : entry.key))])]);
