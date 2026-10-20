import type { Handling, PricingMode, TempZone } from '@storewright/domain';

/**
 * 合成商品原型：每个类别若干原型，生成 SKU 时在原型基础上加入随机变化。
 * 尺寸（厘米）和重量（千克）取自常见包装规格的量级，仅用于仿真，不对应任何真实商品。
 */
export interface Archetype {
  stem: string;
  weight: number;
  dims: [number, number, number];
  kg: [number, number];
  price: [number, number];
  pricing?: PricingMode;
  handling?: Handling[];
  sizes?: string[];
  flavors?: string[];
}

export interface CategoryProfile {
  /** SKU 数量占比（相对值） */
  skuShare: number;
  /** 需求占比（相对值） */
  demandShare: number;
  shelfAvailability: [number, number];
  backroomAvailability: [number, number];
  archetypes: Archetype[];
}

const FLAVORS = ['Original', 'Classic', 'Lightly Salted', 'Honey', 'Vanilla', 'Chocolate', 'Strawberry', 'Spicy', 'Garlic & Herb', 'Unsweetened'];

export const CATEGORY_PROFILES: Record<string, CategoryProfile> = {
  'produce-amb': {
    skuShare: 3, demandShare: 9, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.3, 0.6],
    archetypes: [
      { stem: 'Bananas', weight: 3, dims: [22, 15, 10], kg: [0.9, 1.4], price: [1.2, 1.8], pricing: 'WEIGHT' },
      { stem: 'Potatoes', weight: 2, dims: [30, 20, 10], kg: [2.2, 4.5], price: [3, 6] },
      { stem: 'Onions', weight: 2, dims: [25, 18, 10], kg: [1.3, 2.3], price: [2, 4] },
      { stem: 'Apples', weight: 3, dims: [9, 9, 9], kg: [0.18, 0.25], price: [3.5, 5.5], pricing: 'WEIGHT' },
      { stem: 'Avocados', weight: 2, dims: [10, 7, 7], kg: [0.17, 0.25], price: [0.8, 1.8] },
    ],
  },
  'produce-chl': {
    skuShare: 3, demandShare: 7, shelfAvailability: [0.9, 0.97], backroomAvailability: [0.2, 0.5],
    archetypes: [
      { stem: 'Salad Mix', weight: 3, dims: [22, 15, 10], kg: [0.15, 0.35], price: [2.5, 5] },
      { stem: 'Berries', weight: 3, dims: [15, 10, 7], kg: [0.17, 0.5], price: [2.5, 6], handling: ['FRAGILE'] },
      { stem: 'Broccoli', weight: 2, dims: [18, 14, 12], kg: [0.3, 0.6], price: [1.5, 3], pricing: 'WEIGHT' },
      { stem: 'Herbs', weight: 1, dims: [18, 8, 3], kg: [0.03, 0.06], price: [1.5, 2.5] },
    ],
  },
  bakery: {
    skuShare: 3, demandShare: 6, shelfAvailability: [0.92, 0.98], backroomAvailability: [0.3, 0.6],
    archetypes: [
      { stem: 'Sandwich Bread', weight: 4, dims: [30, 12, 12], kg: [0.55, 0.8], price: [2, 4.5] },
      { stem: 'Bagels', weight: 2, dims: [22, 14, 9], kg: [0.4, 0.6], price: [3, 5] },
      { stem: 'Tortillas', weight: 2, dims: [25, 25, 3], kg: [0.4, 0.9], price: [2.5, 4.5] },
      { stem: 'Muffins', weight: 1, dims: [20, 15, 10], kg: [0.3, 0.5], price: [3.5, 6] },
    ],
  },
  snacks: {
    skuShare: 7, demandShare: 7, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Potato Chips', weight: 4, dims: [30, 22, 8], kg: [0.2, 0.4], price: [3, 5.5], flavors: FLAVORS },
      { stem: 'Crackers', weight: 3, dims: [24, 16, 6], kg: [0.2, 0.4], price: [2.5, 4.5] },
      { stem: 'Cookies', weight: 3, dims: [22, 15, 6], kg: [0.3, 0.5], price: [3, 5], flavors: FLAVORS },
      { stem: 'Nuts', weight: 2, dims: [14, 9, 9], kg: [0.25, 0.5], price: [4, 9] },
    ],
  },
  'dry-goods': {
    skuShare: 7, demandShare: 6, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Pasta', weight: 4, dims: [24, 8, 5], kg: [0.45, 0.5], price: [1.2, 2.5] },
      { stem: 'Long Grain Rice', weight: 3, dims: [25, 15, 8], kg: [0.9, 4.5], price: [2, 9], sizes: ['2 lb', '5 lb', '10 lb'] },
      { stem: 'Flour', weight: 2, dims: [25, 15, 9], kg: [2.2, 4.5], price: [3, 6] },
      { stem: 'Pasta Sauce', weight: 3, dims: [8, 8, 15], kg: [0.7, 0.75], price: [2, 5] },
    ],
  },
  canned: {
    skuShare: 6, demandShare: 5, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Canned Beans', weight: 4, dims: [8, 8, 11], kg: [0.43, 0.46], price: [0.9, 1.8] },
      { stem: 'Canned Tomatoes', weight: 3, dims: [8, 8, 11], kg: [0.4, 0.8], price: [1, 2.5] },
      { stem: 'Soup', weight: 3, dims: [7, 7, 10], kg: [0.3, 0.55], price: [1.2, 3] },
      { stem: 'Tuna', weight: 2, dims: [9, 9, 4], kg: [0.14, 0.17], price: [1, 2.5] },
    ],
  },
  breakfast: {
    skuShare: 4, demandShare: 4, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Cereal', weight: 4, dims: [28, 20, 7], kg: [0.3, 0.6], price: [3, 6], flavors: FLAVORS },
      { stem: 'Oatmeal', weight: 2, dims: [20, 13, 13], kg: [0.5, 1.2], price: [3, 5] },
      { stem: 'Peanut Butter', weight: 2, dims: [10, 10, 13], kg: [0.45, 1.1], price: [2.5, 5] },
    ],
  },
  beverages: {
    skuShare: 5, demandShare: 6, shelfAvailability: [0.93, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Juice 52 oz', weight: 3, dims: [10, 10, 26], kg: [1.6, 1.7], price: [2.5, 4.5] },
      { stem: 'Soda 2 L', weight: 3, dims: [11, 11, 32], kg: [2.1, 2.2], price: [1.8, 3] },
      { stem: 'Coffee', weight: 2, dims: [15, 10, 10], kg: [0.3, 0.9], price: [6, 14] },
      { stem: 'Sparkling Water 8-pack', weight: 2, dims: [26, 13, 12], kg: [3.0, 3.1], price: [4, 6] },
    ],
  },
  water: {
    skuShare: 1, demandShare: 3, shelfAvailability: [0.9, 0.98], backroomAvailability: [0.7, 0.9],
    archetypes: [
      { stem: 'Water 24-pack', weight: 3, dims: [40, 27, 24], kg: [10.5, 11.5], price: [4, 7] },
      { stem: 'Soda 12-pack', weight: 2, dims: [40, 13, 13], kg: [4.6, 4.8], price: [6, 9] },
    ],
  },
  alcohol: {
    skuShare: 4, demandShare: 3, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Beer 6-pack', weight: 3, dims: [20, 14, 24], kg: [2.2, 2.4], price: [8, 13] },
      { stem: 'Beer 12-pack', weight: 2, dims: [40, 27, 12], kg: [4.6, 4.9], price: [14, 22] },
      { stem: 'Wine', weight: 3, dims: [8, 8, 30], kg: [1.2, 1.4], price: [8, 25] },
    ],
  },
  dairy: {
    skuShare: 5, demandShare: 9, shelfAvailability: [0.93, 0.99], backroomAvailability: [0.4, 0.7],
    archetypes: [
      { stem: 'Milk 1 gal', weight: 4, dims: [15, 15, 25], kg: [3.8, 4.0], price: [3, 5] },
      { stem: 'Yogurt', weight: 4, dims: [10, 10, 8], kg: [0.15, 0.95], price: [1, 6], flavors: FLAVORS },
      { stem: 'Cheese', weight: 3, dims: [15, 10, 3], kg: [0.2, 0.45], price: [3, 7] },
      { stem: 'Butter', weight: 2, dims: [14, 7, 7], kg: [0.45, 0.46], price: [4, 6] },
    ],
  },
  eggs: {
    skuShare: 1, demandShare: 4, shelfAvailability: [0.88, 0.97], backroomAvailability: [0.4, 0.7],
    archetypes: [{ stem: 'Eggs 12 ct', weight: 4, dims: [30, 11, 7], kg: [0.68, 0.72], price: [2.5, 6], handling: ['FRAGILE'] }],
  },
  meat: {
    skuShare: 4, demandShare: 6, shelfAvailability: [0.9, 0.97], backroomAvailability: [0.3, 0.6],
    archetypes: [
      { stem: 'Chicken Breast', weight: 3, dims: [25, 18, 5], kg: [0.6, 1.4], price: [6, 9], pricing: 'WEIGHT' },
      { stem: 'Ground Beef', weight: 3, dims: [20, 14, 5], kg: [0.45, 1.4], price: [8, 12], pricing: 'WEIGHT' },
      { stem: 'Salmon Fillet', weight: 1, dims: [25, 12, 4], kg: [0.3, 0.7], price: [18, 26], pricing: 'WEIGHT' },
      { stem: 'Bacon', weight: 2, dims: [28, 15, 2], kg: [0.34, 0.45], price: [5, 8] },
    ],
  },
  deli: {
    skuShare: 2, demandShare: 3, shelfAvailability: [0.92, 0.98], backroomAvailability: [0.3, 0.6],
    archetypes: [
      { stem: 'Sliced Turkey', weight: 3, dims: [18, 12, 4], kg: [0.2, 0.45], price: [4, 7] },
      { stem: 'Hummus', weight: 2, dims: [12, 12, 6], kg: [0.28, 0.45], price: [3, 5] },
    ],
  },
  'frozen-meals': {
    skuShare: 4, demandShare: 4, shelfAvailability: [0.93, 0.99], backroomAvailability: [0.4, 0.75],
    archetypes: [
      { stem: 'Frozen Pizza', weight: 3, dims: [31, 31, 5], kg: [0.5, 0.9], price: [4, 8] },
      { stem: 'Frozen Entrée', weight: 4, dims: [22, 16, 5], kg: [0.28, 0.5], price: [3, 6] },
    ],
  },
  'frozen-veg': {
    skuShare: 2, demandShare: 3, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.4, 0.75],
    archetypes: [{ stem: 'Frozen Vegetables', weight: 4, dims: [20, 14, 5], kg: [0.34, 0.9], price: [1.5, 4] }],
  },
  'ice-cream': {
    skuShare: 2, demandShare: 2, shelfAvailability: [0.92, 0.98], backroomAvailability: [0.4, 0.7],
    archetypes: [{ stem: 'Ice Cream 1.5 qt', weight: 4, dims: [15, 15, 12], kg: [1.0, 1.3], price: [4, 7], flavors: FLAVORS }],
  },
  ice: {
    skuShare: 0.3, demandShare: 1, shelfAvailability: [0.9, 0.98], backroomAvailability: [0.6, 0.9],
    archetypes: [{ stem: 'Bagged Ice', weight: 3, dims: [45, 30, 10], kg: [4.4, 4.6], price: [2.5, 4] }],
  },
  cleaning: {
    skuShare: 4, demandShare: 3, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Laundry Detergent', weight: 3, dims: [25, 15, 30], kg: [2.5, 4.5], price: [8, 16], handling: ['CHEMICAL'] },
      { stem: 'Bleach', weight: 2, dims: [15, 10, 30], kg: [3.6, 3.9], price: [3, 6], handling: ['CHEMICAL'] },
      { stem: 'Dish Soap', weight: 3, dims: [8, 5, 22], kg: [0.6, 1.0], price: [2.5, 5], handling: ['CHEMICAL'] },
    ],
  },
  paper: {
    skuShare: 2, demandShare: 3, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Paper Towels 6-roll', weight: 3, dims: [50, 30, 25], kg: [1.4, 2.0], price: [8, 15] },
      { stem: 'Toilet Paper 12-roll', weight: 3, dims: [45, 30, 22], kg: [1.5, 2.2], price: [9, 18] },
    ],
  },
  'health-beauty': {
    skuShare: 6, demandShare: 3, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Shampoo', weight: 3, dims: [8, 5, 20], kg: [0.4, 0.8], price: [4, 10] },
      { stem: 'Toothpaste', weight: 3, dims: [20, 5, 4], kg: [0.1, 0.2], price: [2.5, 6] },
      { stem: 'Vitamins', weight: 2, dims: [7, 7, 12], kg: [0.15, 0.3], price: [8, 18] },
    ],
  },
  baby: {
    skuShare: 2, demandShare: 2, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Diapers', weight: 3, dims: [40, 25, 20], kg: [2.0, 3.2], price: [20, 35] },
      { stem: 'Baby Wipes', weight: 2, dims: [20, 12, 8], kg: [0.4, 0.8], price: [3, 8] },
    ],
  },
  pet: {
    skuShare: 3, demandShare: 2, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Dry Dog Food 30 lb', weight: 2, dims: [60, 40, 12], kg: [13.5, 13.7], price: [28, 45] },
      { stem: 'Cat Food Cans', weight: 3, dims: [8, 8, 4], kg: [0.15, 0.16], price: [0.7, 1.5] },
      { stem: 'Cat Litter 20 lb', weight: 1, dims: [35, 25, 25], kg: [9.0, 9.2], price: [9, 16] },
    ],
  },
  household: {
    skuShare: 3, demandShare: 2, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Trash Bags', weight: 3, dims: [22, 12, 12], kg: [0.8, 1.5], price: [6, 12] },
      { stem: 'Aluminum Foil', weight: 2, dims: [32, 6, 6], kg: [0.3, 0.6], price: [3, 7] },
      { stem: 'Light Bulbs', weight: 1, dims: [15, 10, 10], kg: [0.15, 0.3], price: [5, 12], handling: ['FRAGILE'] },
    ],
  },
  electronics: {
    skuShare: 3, demandShare: 2, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Headphones', weight: 3, dims: [22, 18, 8], kg: [0.3, 0.6], price: [20, 120] },
      { stem: 'Phone Charger', weight: 3, dims: [15, 10, 4], kg: [0.1, 0.2], price: [12, 30] },
      { stem: '43 in TV', weight: 1, dims: [110, 68, 14], kg: [9, 11], price: [180, 320] },
    ],
  },
  toys: {
    skuShare: 3, demandShare: 2, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Building Set', weight: 3, dims: [38, 26, 7], kg: [0.6, 1.4], price: [15, 60] },
      { stem: 'Board Game', weight: 2, dims: [40, 27, 7], kg: [0.8, 1.2], price: [15, 35] },
    ],
  },
  home: {
    skuShare: 3, demandShare: 1.5, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Storage Bin', weight: 3, dims: [45, 30, 25], kg: [1.0, 2.0], price: [8, 18] },
      { stem: 'Bath Towel Set', weight: 2, dims: [35, 25, 12], kg: [1.2, 2.0], price: [15, 35] },
    ],
  },
  apparel: {
    skuShare: 3, demandShare: 1.5, shelfAvailability: [0.93, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [{ stem: 'T-Shirt', weight: 3, dims: [30, 25, 3], kg: [0.2, 0.3], price: [6, 15], sizes: ['S', 'M', 'L', 'XL'] }],
  },
  automotive: {
    skuShare: 1.5, demandShare: 1, shelfAvailability: [0.95, 0.99], backroomAvailability: [0.6, 0.85],
    archetypes: [
      { stem: 'Motor Oil 5 qt', weight: 3, dims: [25, 15, 28], kg: [4.5, 4.7], price: [22, 35], handling: ['HAZMAT'] },
      { stem: 'Car Battery', weight: 1, dims: [26, 17, 19], kg: [17, 19], price: [110, 180], handling: ['HAZMAT'] },
      { stem: 'All-Season Tire', weight: 1, dims: [66, 66, 21], kg: [9.5, 11], price: [80, 160] },
      { stem: 'Wiper Blades', weight: 2, dims: [60, 8, 4], kg: [0.3, 0.4], price: [12, 25] },
    ],
  },
  outdoor: {
    skuShare: 1.5, demandShare: 1, shelfAvailability: [0.94, 0.99], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Folding Chair', weight: 2, dims: [85, 15, 15], kg: [3, 4.5], price: [15, 35] },
      { stem: 'Charcoal 16 lb', weight: 2, dims: [45, 30, 12], kg: [7.2, 7.3], price: [10, 16] },
      { stem: 'Gas Grill', weight: 1, dims: [80, 60, 50], kg: [24, 28], price: [180, 350] },
    ],
  },
  seasonal: {
    skuShare: 2, demandShare: 1, shelfAvailability: [0.9, 0.98], backroomAvailability: [0.5, 0.8],
    archetypes: [
      { stem: 'Holiday Decor', weight: 3, dims: [30, 20, 15], kg: [0.3, 1.5], price: [5, 25] },
      { stem: 'Ice Melt 25 lb', weight: 1, dims: [45, 30, 12], kg: [11.3, 11.4], price: [10, 16] },
    ],
  },
};

/** 自定义类别没有合成原型时，按温区使用的通用原型 */
export function fallbackProfile(temp: TempZone): CategoryProfile {
  return {
    skuShare: 2,
    demandShare: 1.5,
    shelfAvailability: [0.93, 0.99],
    backroomAvailability: [0.5, 0.8],
    archetypes: [{ stem: temp === 'FROZEN' ? 'Frozen Item' : temp === 'CHILLED' ? 'Chilled Item' : 'Item', weight: 1, dims: [20, 15, 10], kg: [0.3, 1.5], price: [2, 12] }],
  };
}
