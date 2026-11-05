// The built-in component library. Each entry pairs a schematic symbol with a
// footprint and a 3D body. Generic passives carry a default value the user
// edits after placing; specific parts carry common, widely second-sourced
// part numbers as their value.

import * as S from './symbols.js';
import * as F from './footprints.js';

export const CATEGORIES = [
  'Resistors', 'Capacitors', 'Inductors', 'Diodes', 'LEDs', 'Transistors',
  'Integrated Circuits', 'Power', 'Crystals & Oscillators', 'Connectors',
  'Switches', 'Mechanical', 'Miscellaneous',
];

const list = [];

function add(def) {
  list.push({
    params: {},
    keywords: [],
    ...def,
  });
}

// ---------------------------------------------------------------- resistors

for (const size of ['0201', '0402', '0603', '0805', '1206', '2512']) {
  add({
    id: `res-${size}`, name: `Resistor ${size}`, category: 'Resistors', prefix: 'R', value: '10k',
    description: `Thick film chip resistor, ${size} package`,
    params: { Tolerance: '1%', Power: { '0201': '1/20W', '0402': '1/16W', '0603': '1/10W', '0805': '1/8W', '1206': '1/4W', '2512': '1W' }[size] },
    keywords: ['resistor', 'res', 'smd', 'chip', size],
    symbol: S.resistor(), footprint: F.chip(size, 'R'),
  });
}
add({
  id: 'res-axial', name: 'Resistor axial', category: 'Resistors', prefix: 'R', value: '10k',
  description: 'Through-hole axial resistor, 0.25 W, 10.16 mm lead spacing',
  params: { Tolerance: '1%', Power: '1/4W' }, keywords: ['resistor', 'tht', 'axial', 'through hole'],
  symbol: S.resistor(), footprint: F.axial({ pitch: 10.16, bodyL: 6.3, bodyD: 2.5, name: 'AXIAL-10.16' }),
});
add({
  id: 'pot-trimmer', name: 'Trimmer potentiometer', category: 'Resistors', prefix: 'RV', value: '10k',
  description: 'Single-turn trimmer potentiometer, through hole', keywords: ['potentiometer', 'pot', 'trimmer', 'variable'],
  symbol: S.potentiometer(), footprint: F.trimmer(),
});
add({
  id: 'ntc-0603', name: 'NTC thermistor 0603', category: 'Resistors', prefix: 'TH', value: '10k',
  description: 'NTC thermistor, 0603 package, temperature sensing resistor', params: { Beta: '3380K' },
  keywords: ['thermistor', 'ntc', 'temperature', 'sensor'],
  symbol: S.thermistor(), footprint: F.chip('0603', 'R'),
});

// ---------------------------------------------------------------- capacitors

const CAP_DEFAULT = { '0201': '100nF', '0402': '100nF', '0603': '100nF', '0805': '1uF', '1206': '10uF', '1210': '22uF' };
for (const size of Object.keys(CAP_DEFAULT)) {
  add({
    id: `cap-${size}`, name: `Capacitor ${size}`, category: 'Capacitors', prefix: 'C', value: CAP_DEFAULT[size],
    description: `Multilayer ceramic capacitor, ${size} package`,
    params: { Voltage: '16V', Dielectric: 'X7R' }, keywords: ['capacitor', 'cap', 'mlcc', 'ceramic', 'smd', size],
    symbol: S.capacitor(), footprint: F.chip(size, 'C'),
  });
}
for (const [d, h, pitch, value, volts] of [[5, 11, 2.0, '10uF', '25V'], [6.3, 11, 2.5, '100uF', '16V'], [8, 11.5, 3.5, '220uF', '25V'], [10, 16, 5.0, '1000uF', '16V']]) {
  add({
    id: `cap-elec-rad-${d}x${h}`, name: `Electrolytic ${d}x${h} radial`, category: 'Capacitors', prefix: 'C', value,
    description: `Aluminium electrolytic capacitor, radial, ${d} mm diameter, ${h} mm tall`,
    params: { Voltage: volts }, keywords: ['capacitor', 'electrolytic', 'polarized', 'radial', 'tht', 'bulk'],
    symbol: S.polarizedCapacitor(), footprint: F.radialCap({ d, pitch, height: h }),
  });
}
for (const [size, value] of [['4x5.4', '10uF'], ['5x5.4', '22uF'], ['6.3x5.4', '47uF'], ['6.3x7.7', '100uF'], ['8x10.2', '330uF']]) {
  add({
    id: `cap-elec-smd-${size}`, name: `Electrolytic ${size} SMD`, category: 'Capacitors', prefix: 'C', value,
    description: `Aluminium electrolytic capacitor, surface mount, ${size} mm`,
    params: { Voltage: '16V' }, keywords: ['capacitor', 'electrolytic', 'polarized', 'smd', 'can', 'bulk'],
    symbol: S.polarizedCapacitor(), footprint: F.smdElectrolytic(size),
  });
}

// ---------------------------------------------------------------- inductors

for (const size of ['0603', '0805', '1210']) {
  add({
    id: `ind-${size}`, name: `Inductor ${size}`, category: 'Inductors', prefix: 'L', value: size === '1210' ? '10uH' : '1uH',
    description: `Multilayer chip inductor, ${size} package`, keywords: ['inductor', 'coil', 'smd', size],
    symbol: S.inductor(), footprint: F.chip(size, 'L'),
  });
}
for (const [size, value] of [['4x4', '4.7uH'], ['6x6', '10uH']]) {
  add({
    id: `ind-power-${size}`, name: `Power inductor ${size}`, category: 'Inductors', prefix: 'L', value,
    description: `Shielded power inductor for switching regulators, ${size} mm`, params: { Current: size === '4x4' ? '2A' : '3A' },
    keywords: ['inductor', 'power', 'shielded', 'buck', 'boost'],
    symbol: S.inductor(), footprint: F.inductorPower(size),
  });
}
for (const size of ['0603', '0805']) {
  add({
    id: `ferrite-${size}`, name: `Ferrite bead ${size}`, category: 'Inductors', prefix: 'FB', value: '600R@100MHz',
    description: `Chip ferrite bead for EMI suppression, ${size} package`, keywords: ['ferrite', 'bead', 'emi', 'filter', size],
    symbol: S.ferriteBead(), footprint: F.chip(size, 'L'),
  });
}

// ---------------------------------------------------------------- diodes

add({
  id: 'diode-signal-sod123', name: 'Signal diode SOD-123', category: 'Diodes', prefix: 'D', value: '1N4148W',
  description: 'Fast switching signal diode, 100 V, 150 mA', keywords: ['diode', 'signal', 'switching', 'small'],
  symbol: S.diode(), footprint: F.moldedBody('SOD-123'),
});
add({
  id: 'diode-signal-sod323', name: 'Signal diode SOD-323', category: 'Diodes', prefix: 'D', value: '1N4148WS',
  description: 'Fast switching signal diode, 100 V, 150 mA, small package', keywords: ['diode', 'signal', 'switching'],
  symbol: S.diode(), footprint: F.moldedBody('SOD-323'),
});
add({
  id: 'diode-rect-sma', name: 'Rectifier SMA', category: 'Diodes', prefix: 'D', value: 'M7',
  description: 'General purpose rectifier, 1000 V, 1 A', keywords: ['diode', 'rectifier', 'power'],
  symbol: S.diode(), footprint: F.moldedBody('SMA'),
});
add({
  id: 'diode-rect-axial', name: 'Rectifier axial', category: 'Diodes', prefix: 'D', value: '1N4007',
  description: 'General purpose rectifier, 1000 V, 1 A, through-hole axial package', keywords: ['diode', 'rectifier', 'tht', 'axial'],
  symbol: S.diode(), footprint: F.axial({ pitch: 10.16, bodyL: 5.2, bodyD: 2.7, polarized: true, name: 'DO-41' }),
});
add({
  id: 'schottky-sma', name: 'Schottky SMA', category: 'Diodes', prefix: 'D', value: 'SS34',
  description: 'Schottky rectifier, 40 V, 3 A, low forward voltage', keywords: ['diode', 'schottky', 'rectifier', 'power'],
  symbol: S.schottky(), footprint: F.moldedBody('SMA'),
});
add({
  id: 'schottky-sod123', name: 'Schottky SOD-123', category: 'Diodes', prefix: 'D', value: 'B5819W',
  description: 'Schottky diode, 40 V, 1 A', keywords: ['diode', 'schottky'],
  symbol: S.schottky(), footprint: F.moldedBody('SOD-123'),
});
add({
  id: 'zener-sod123', name: 'Zener SOD-123', category: 'Diodes', prefix: 'D', value: '5.1V',
  description: 'Zener diode, 500 mW', params: { Power: '500mW' }, keywords: ['diode', 'zener', 'reference', 'clamp'],
  symbol: S.zener(), footprint: F.moldedBody('SOD-123'),
});
add({
  id: 'tvs-bidir-sma', name: 'TVS bidirectional SMA', category: 'Diodes', prefix: 'D', value: '5V',
  description: 'Bidirectional transient voltage suppressor, 400 W', keywords: ['tvs', 'esd', 'protection', 'transient'],
  symbol: S.tvs(), footprint: F.moldedBody('SMA'),
});

// ---------------------------------------------------------------- LEDs

const LED_COLORS = {
  red: ['Red', '#d42a2a', '2.0V'], green: ['Green', '#2ab84a', '2.1V'], blue: ['Blue', '#2a5ad4', '3.0V'],
  yellow: ['Yellow', '#e8c82a', '2.1V'], white: ['White', '#f0f0f0', '3.0V'],
};
for (const size of ['0603', '0805']) {
  for (const [key, [label, color, vf]] of Object.entries(LED_COLORS)) {
    add({
      id: `led-${size}-${key}`, name: `LED ${label} ${size}`, category: 'LEDs', prefix: 'D', value: label,
      description: `${label} chip LED, ${size} package`, params: { Color: label, Vf: vf },
      keywords: ['led', 'light', 'indicator', key, size],
      symbol: S.led(), footprint: F.chip(size, 'D', { color }),
    });
  }
}
for (const [d, colors] of [[3, ['red', 'green']], [5, ['red', 'green', 'blue', 'yellow', 'white']]]) {
  for (const key of colors) {
    const [label, color, vf] = LED_COLORS[key];
    add({
      id: `led-${d}mm-${key}`, name: `LED ${label} ${d}mm`, category: 'LEDs', prefix: 'D', value: label,
      description: `${label} ${d} mm round through-hole LED`, params: { Color: label, Vf: vf },
      keywords: ['led', 'light', 'indicator', 'tht', key, `${d}mm`],
      symbol: S.led(), footprint: F.ledTHT(d, { color }),
    });
  }
}

// ---------------------------------------------------------------- transistors

add({
  id: 'npn-sot23', name: 'NPN transistor SOT-23', category: 'Transistors', prefix: 'Q', value: 'MMBT3904',
  description: 'NPN bipolar transistor, 40 V, 200 mA, general purpose', keywords: ['transistor', 'bjt', 'npn'],
  symbol: S.bjt('npn', { b: '1', e: '2', c: '3' }), footprint: F.sot23(3),
});
add({
  id: 'pnp-sot23', name: 'PNP transistor SOT-23', category: 'Transistors', prefix: 'Q', value: 'MMBT3906',
  description: 'PNP bipolar transistor, 40 V, 200 mA, general purpose', keywords: ['transistor', 'bjt', 'pnp'],
  symbol: S.bjt('pnp', { b: '1', e: '2', c: '3' }), footprint: F.sot23(3),
});
add({
  id: 'npn-to92', name: 'NPN transistor TO-92', category: 'Transistors', prefix: 'Q', value: '2N3904',
  description: 'NPN bipolar transistor, 40 V, 200 mA, through hole (E B C)', keywords: ['transistor', 'bjt', 'npn', 'tht'],
  symbol: S.bjt('npn', { e: '1', b: '2', c: '3' }), footprint: F.to92(),
});
add({
  id: 'pnp-to92', name: 'PNP transistor TO-92', category: 'Transistors', prefix: 'Q', value: '2N3906',
  description: 'PNP bipolar transistor, 40 V, 200 mA, through hole (E B C)', keywords: ['transistor', 'bjt', 'pnp', 'tht'],
  symbol: S.bjt('pnp', { e: '1', b: '2', c: '3' }), footprint: F.to92(),
});
add({
  id: 'nmos-sot23', name: 'N-MOSFET SOT-23', category: 'Transistors', prefix: 'Q', value: '2N7002',
  description: 'N-channel MOSFET, 60 V, 300 mA, small signal', keywords: ['mosfet', 'fet', 'nmos', 'n-channel', 'switch'],
  symbol: S.mosfet('n', { g: '1', s: '2', d: '3' }), footprint: F.sot23(3),
});
add({
  id: 'nmos-logic-sot23', name: 'N-MOSFET logic level SOT-23', category: 'Transistors', prefix: 'Q', value: 'N-MOSFET 30V 5A',
  description: 'N-channel logic level MOSFET, 30 V, 5 A, low gate threshold', keywords: ['mosfet', 'fet', 'nmos', 'logic level', 'switch', 'load'],
  symbol: S.mosfet('n', { g: '1', s: '2', d: '3' }), footprint: F.sot23(3),
});
add({
  id: 'pmos-sot23', name: 'P-MOSFET SOT-23', category: 'Transistors', prefix: 'Q', value: 'P-MOSFET 30V 4A',
  description: 'P-channel MOSFET, 30 V, 4 A, high-side switch', keywords: ['mosfet', 'fet', 'pmos', 'p-channel', 'switch'],
  symbol: S.mosfet('p', { g: '1', s: '2', d: '3' }), footprint: F.sot23(3),
});
add({
  id: 'nmos-to220', name: 'N-MOSFET TO-220', category: 'Transistors', prefix: 'Q', value: 'N-MOSFET 55V 40A',
  description: 'N-channel power MOSFET, logic level, through hole (G D S)', keywords: ['mosfet', 'power', 'nmos', 'tht'],
  symbol: S.mosfet('n', { g: '1', d: '2', s: '3' }), footprint: F.to220(),
});
add({
  id: 'nmos-dpak', name: 'N-MOSFET DPAK', category: 'Transistors', prefix: 'Q', value: 'N-MOSFET 60V 30A',
  description: 'N-channel power MOSFET, surface mount TO-252, drain on tab', keywords: ['mosfet', 'power', 'nmos', 'dpak', 'smd'],
  symbol: S.mosfet('n', { g: '1', d: '2', s: '3' }), footprint: F.dpak(),
});

// ---------------------------------------------------------------- integrated circuits

const pins = (spec) => spec.map(([num, name, type = 'passive']) => ({ num: String(num), name, type }));

const timer555 = () => S.icSymbol({
  left: pins([[2, '~TRIG', 'input'], [6, 'THR', 'input'], [5, 'CV', 'input'], [4, '~RESET', 'input']]),
  right: pins([[3, 'OUT', 'output'], [7, 'DIS', 'opencollector']]),
  top: pins([[8, 'VCC', 'power']]),
  bottom: pins([[1, 'GND', 'power']]),
});
add({
  id: 'ic-555-soic8', name: '555 timer SOIC-8', category: 'Integrated Circuits', prefix: 'U', value: 'NE555',
  description: 'Precision timer, astable or monostable operation', keywords: ['timer', '555', 'oscillator', 'pwm'],
  symbol: timer555(), footprint: F.soic(8),
});
add({
  id: 'ic-555-dip8', name: '555 timer DIP-8', category: 'Integrated Circuits', prefix: 'U', value: 'NE555',
  description: 'Precision timer, astable or monostable operation, through hole', keywords: ['timer', '555', 'oscillator', 'tht'],
  symbol: timer555(), footprint: F.dip({ pins: 8 }),
});
add({
  id: 'opamp-dual-soic8', name: 'Dual op-amp SOIC-8', category: 'Integrated Circuits', prefix: 'U', value: 'LM358',
  description: 'Dual general purpose operational amplifier, single supply 3 V to 32 V', keywords: ['opamp', 'op-amp', 'amplifier', 'dual', 'analog'],
  symbol: S.dualOpamp(), footprint: F.soic(8),
});
add({
  id: 'opamp-dual-dip8', name: 'Dual op-amp DIP-8', category: 'Integrated Circuits', prefix: 'U', value: 'LM358',
  description: 'Dual general purpose operational amplifier, through hole', keywords: ['opamp', 'op-amp', 'amplifier', 'dual', 'tht'],
  symbol: S.dualOpamp(), footprint: F.dip({ pins: 8 }),
});
add({
  id: 'opamp-single-sot23-5', name: 'Op-amp SOT-23-5', category: 'Integrated Circuits', prefix: 'U', value: 'Op-amp RRIO',
  description: 'Single rail-to-rail input and output operational amplifier', keywords: ['opamp', 'op-amp', 'amplifier', 'single', 'rail to rail'],
  symbol: S.opamp({ out: '1', vn: '2', inp: '3', inn: '4', vp: '5' }), footprint: F.sot23(5),
});
add({
  id: 'comparator-dual-soic8', name: 'Dual comparator SOIC-8', category: 'Integrated Circuits', prefix: 'U', value: 'LM393',
  description: 'Dual voltage comparator with open-collector outputs', keywords: ['comparator', 'dual', 'analog'],
  symbol: S.dualOpamp({ outType: 'opencollector' }), footprint: F.soic(8),
});
add({
  id: 'ic-74hc595-soic16', name: 'Shift register 74HC595', category: 'Integrated Circuits', prefix: 'U', value: '74HC595',
  description: '8-bit serial-in, parallel-out shift register with output latches', keywords: ['shift register', 'logic', '595', 'serial', 'io expander'],
  symbol: S.icSymbol({
    left: pins([[14, 'SER', 'input'], [11, 'SRCLK', 'input'], [12, 'RCLK', 'input'], [10, '~SRCLR', 'input'], [13, '~OE', 'input']]),
    right: pins([[15, 'QA', 'output'], [1, 'QB', 'output'], [2, 'QC', 'output'], [3, 'QD', 'output'], [4, 'QE', 'output'], [5, 'QF', 'output'], [6, 'QG', 'output'], [7, 'QH', 'output'], [9, "QH'", 'output']]),
    top: pins([[16, 'VCC', 'power']]),
    bottom: pins([[8, 'GND', 'power']]),
  }),
  footprint: F.soic(16),
});
add({
  id: 'ic-74hc04-soic14', name: 'Hex inverter 74HC04', category: 'Integrated Circuits', prefix: 'U', value: '74HC04',
  description: 'Six independent logic inverters', keywords: ['inverter', 'logic', 'not', 'gate'],
  symbol: S.icSymbol({
    left: pins([[1, '1A', 'input'], [3, '2A', 'input'], [5, '3A', 'input'], [9, '4A', 'input'], [11, '5A', 'input'], [13, '6A', 'input']]),
    right: pins([[2, '1Y', 'output'], [4, '2Y', 'output'], [6, '3Y', 'output'], [8, '4Y', 'output'], [10, '5Y', 'output'], [12, '6Y', 'output']]),
    top: pins([[14, 'VCC', 'power']]),
    bottom: pins([[7, 'GND', 'power']]),
  }),
  footprint: F.soic(14),
});
add({
  id: 'eeprom-i2c-soic8', name: 'I2C EEPROM SOIC-8', category: 'Integrated Circuits', prefix: 'U', value: '24LC256',
  description: 'Serial EEPROM, I2C interface, 256 kbit', keywords: ['eeprom', 'memory', 'i2c', 'storage'],
  symbol: S.icSymbol({
    left: pins([[1, 'A0', 'input'], [2, 'A1', 'input'], [3, 'A2', 'input'], [7, 'WP', 'input']]),
    right: pins([[5, 'SDA', 'bidir'], [6, 'SCL', 'input']]),
    top: pins([[8, 'VCC', 'power']]),
    bottom: pins([[4, 'GND', 'power']]),
  }),
  footprint: F.soic(8),
});
add({
  id: 'mcu-atmega328p-tqfp32', name: 'ATmega328P TQFP-32', category: 'Integrated Circuits', prefix: 'U', value: 'ATmega328P',
  description: '8-bit AVR microcontroller, 32 KB flash, 2 KB SRAM, 20 MHz', keywords: ['mcu', 'microcontroller', 'avr', 'atmega'],
  symbol: S.icSymbol({
    left: pins([
      [4, 'VCC', 'power'], [6, 'VCC', 'power'], [18, 'AVCC', 'power'], [20, 'AREF', 'input'],
      [29, 'PC6/~RESET', 'input'], [7, 'PB6/XTAL1', 'bidir'], [8, 'PB7/XTAL2', 'bidir'],
      [3, 'GND', 'power'], [5, 'GND', 'power'], [21, 'GND', 'power'],
    ]),
    right: pins([
      [12, 'PB0', 'bidir'], [13, 'PB1', 'bidir'], [14, 'PB2', 'bidir'], [15, 'PB3/MOSI', 'bidir'], [16, 'PB4/MISO', 'bidir'], [17, 'PB5/SCK', 'bidir'],
      [23, 'PC0', 'bidir'], [24, 'PC1', 'bidir'], [25, 'PC2', 'bidir'], [26, 'PC3', 'bidir'], [27, 'PC4/SDA', 'bidir'], [28, 'PC5/SCL', 'bidir'],
      [19, 'ADC6', 'input'], [22, 'ADC7', 'input'],
      [30, 'PD0/RXD', 'bidir'], [31, 'PD1/TXD', 'bidir'], [32, 'PD2', 'bidir'], [1, 'PD3', 'bidir'], [2, 'PD4', 'bidir'], [9, 'PD5', 'bidir'], [10, 'PD6', 'bidir'], [11, 'PD7', 'bidir'],
    ]),
    minWidth: 1000,
  }),
  footprint: F.qfp({ pins: 32, size: 7, pitch: 0.8 }),
});
add({
  id: 'osc-3225', name: 'Oscillator 3225', category: 'Crystals & Oscillators', prefix: 'X', value: '16MHz',
  description: 'CMOS clock oscillator, 3.2 x 2.5 mm, with enable', keywords: ['oscillator', 'clock', 'xo'],
  symbol: S.icSymbol({
    left: pins([[1, 'EN', 'input']]),
    right: pins([[3, 'OUT', 'output']]),
    top: pins([[4, 'VDD', 'power']]),
    bottom: pins([[2, 'GND', 'power']]),
  }),
  footprint: F.crystalSMD('3225'),
});

// ---------------------------------------------------------------- power

add({
  id: 'reg-ldo-1117-sot223', name: 'LDO regulator SOT-223', category: 'Power', prefix: 'U', value: 'AMS1117-3.3',
  description: 'Low dropout linear regulator, 3.3 V, 1 A, tab connected to the output', keywords: ['regulator', 'ldo', 'linear', '3.3v', 'power'],
  symbol: S.regulator({ vin: '3', vout: '2', gnd: '1', gndName: 'GND' }), footprint: F.sot223({ tab: '2' }),
});
add({
  id: 'reg-7805-to220', name: 'Linear regulator TO-220', category: 'Power', prefix: 'U', value: '7805',
  description: 'Positive fixed linear regulator, 5 V, 1.5 A (IN GND OUT)', keywords: ['regulator', 'linear', '5v', 'power', 'tht'],
  symbol: S.regulator({ vin: '1', gnd: '2', vout: '3' }), footprint: F.to220(),
});
add({
  id: 'reg-ldo-sot23-5', name: 'LDO regulator SOT-23-5', category: 'Power', prefix: 'U', value: 'LDO 3.3V 150mA',
  description: 'Low dropout regulator with enable, 150 mA', keywords: ['regulator', 'ldo', 'linear', 'enable', 'power'],
  symbol: S.icSymbol({
    left: pins([[1, 'VIN', 'power'], [3, 'EN', 'input']]),
    right: pins([[5, 'VOUT', 'power'], [4, 'NC', 'nc']]),
    bottom: pins([[2, 'GND', 'power']]),
  }),
  footprint: F.sot23(5),
});
add({
  id: 'fuse-1206', name: 'Fuse 1206', category: 'Power', prefix: 'F', value: '1A',
  description: 'Surface-mount fuse or resettable polyfuse, 1206 package', keywords: ['fuse', 'polyfuse', 'ptc', 'protection'],
  symbol: S.fuse(), footprint: F.chip('1206', 'R'),
});
add({
  id: 'battery-cr2032', name: 'Battery holder 2-pin', category: 'Power', prefix: 'BT', value: '3V',
  description: 'Battery or cell connection, two pins at 2.54 mm', keywords: ['battery', 'cell', 'coin'],
  symbol: S.battery(), footprint: F.header({ rows: 1, cols: 2 }),
});

// ---------------------------------------------------------------- crystals

add({
  id: 'xtal-hc49', name: 'Crystal HC-49', category: 'Crystals & Oscillators', prefix: 'Y', value: '16MHz',
  description: 'Quartz crystal, HC-49 low profile, through hole', params: { Load: '18pF' }, keywords: ['crystal', 'quartz', 'tht', 'clock'],
  symbol: S.crystal(), footprint: F.crystalHC49(),
});
add({
  id: 'xtal-3225', name: 'Crystal 3225 4-pad', category: 'Crystals & Oscillators', prefix: 'Y', value: '16MHz',
  description: 'Quartz crystal, 3.2 x 2.5 mm, pads 2 and 4 to the case', params: { Load: '12pF' }, keywords: ['crystal', 'quartz', 'smd', 'clock'],
  symbol: S.crystal4(), footprint: F.crystalSMD('3225'),
});
add({
  id: 'xtal-5032', name: 'Crystal 5032 2-pad', category: 'Crystals & Oscillators', prefix: 'Y', value: '8MHz',
  description: 'Quartz crystal, 5.0 x 3.2 mm, two pads', params: { Load: '18pF' }, keywords: ['crystal', 'quartz', 'smd', 'clock'],
  symbol: S.crystal(), footprint: F.crystalSMD('5032'),
});

// ---------------------------------------------------------------- connectors

for (let count = 2; count <= 10; count++) {
  add({
    id: `hdr-1x${String(count).padStart(2, '0')}`, name: `Header 1x${count}`, category: 'Connectors', prefix: 'J', value: `1x${count}`,
    description: `Pin header, single row, ${count} pins, 2.54 mm pitch`, keywords: ['header', 'connector', 'pin', 'tht', `${count}`],
    symbol: S.connector1(count), footprint: F.header({ rows: 1, cols: count }),
  });
}
for (const rows of [3, 5, 10]) {
  add({
    id: `hdr-2x${String(rows).padStart(2, '0')}`, name: `Header 2x${rows}`, category: 'Connectors', prefix: 'J', value: `2x${rows}`,
    description: `Pin header, dual row, ${rows * 2} pins, 2.54 mm pitch`, keywords: ['header', 'connector', 'pin', 'dual', 'tht', 'idc'],
    symbol: S.connector2(rows), footprint: F.header({ rows: 2, cols: rows }),
  });
}
for (const [pitch, counts] of [[2.0, [2, 3, 4]], [2.5, [2, 3, 4]]]) {
  for (const count of counts) {
    add({
      id: `conn-${pitch.toFixed(1)}-1x${String(count).padStart(2, '0')}`, name: `Wire-to-board ${pitch.toFixed(1)}mm 1x${count}`,
      category: 'Connectors', prefix: 'J', value: `${count}P ${pitch.toFixed(1)}mm`,
      description: `Locking wire-to-board connector, ${count} pins, ${pitch} mm pitch, vertical`,
      keywords: ['connector', 'wire to board', 'locking', 'cable', `${pitch}mm`],
      symbol: S.connector1(count), footprint: F.wireToBoard({ pins: count, pitch }),
    });
  }
}
for (const count of [2, 3]) {
  add({
    id: `tb-5.08-1x${String(count).padStart(2, '0')}`, name: `Terminal block 1x${count}`, category: 'Connectors', prefix: 'J', value: `${count}P 5.08mm`,
    description: `Screw terminal block, ${count} positions, 5.08 mm pitch`, keywords: ['terminal', 'screw', 'connector', 'power', 'wire'],
    symbol: S.connector1(count), footprint: F.terminalBlock({ pins: count }),
  });
}

// ---------------------------------------------------------------- switches

add({
  id: 'sw-tact-6x6-tht', name: 'Tactile switch 6x6 THT', category: 'Switches', prefix: 'SW', value: 'Push button',
  description: 'Momentary tactile push button, 6 x 6 mm, through hole', keywords: ['switch', 'button', 'tactile', 'push', 'tht'],
  symbol: S.pushButton(), footprint: F.tactile({ smd: false }),
});
add({
  id: 'sw-tact-6x6-smd', name: 'Tactile switch 6x6 SMD', category: 'Switches', prefix: 'SW', value: 'Push button',
  description: 'Momentary tactile push button, 6 x 6 mm, surface mount', keywords: ['switch', 'button', 'tactile', 'push', 'smd'],
  symbol: S.pushButton(), footprint: F.tactile({ smd: true }),
});
add({
  id: 'sw-spst-hdr', name: 'Switch SPST 2-pin', category: 'Switches', prefix: 'SW', value: 'SPST',
  description: 'Single-pole single-throw switch, panel mounted, wired to a 2-pin header', keywords: ['switch', 'toggle', 'spst', 'power'],
  symbol: S.switchSPST(), footprint: F.header({ rows: 1, cols: 2 }),
});

// ---------------------------------------------------------------- mechanical

for (const [size, drill, ring] of [['M2', 2.2, 4.0], ['M2.5', 2.7, 5.0], ['M3', 3.2, 6.0]]) {
  add({
    id: `mh-${size.toLowerCase()}`, name: `Mounting hole ${size}`, category: 'Mechanical', prefix: 'H', value: size,
    description: `Plated mounting hole for ${size} screws, ${ring} mm copper ring`, keywords: ['mounting', 'hole', 'screw', 'standoff', size.toLowerCase()],
    symbol: S.mountingHole(), footprint: F.mountingHole({ drill, pad: ring }),
  });
}
add({
  id: 'mh-m3-npth', name: 'Mounting hole M3 NPTH', category: 'Mechanical', prefix: 'H', value: 'M3',
  description: 'Non-plated mounting hole for M3 screws', keywords: ['mounting', 'hole', 'screw', 'npth', 'm3'],
  symbol: S.mountingHole(), footprint: F.mountingHole({ drill: 3.2 }),
});
add({
  id: 'fiducial-1mm', name: 'Fiducial 1mm', category: 'Mechanical', prefix: 'FID', value: 'Fiducial',
  description: 'Optical alignment mark for assembly machines', keywords: ['fiducial', 'alignment', 'assembly', 'mark'],
  symbol: S.fiducial(), footprint: F.fiducial(),
});

// ---------------------------------------------------------------- miscellaneous

add({
  id: 'tp-1.5', name: 'Test point', category: 'Miscellaneous', prefix: 'TP', value: 'TP',
  description: 'Round test pad, 1.5 mm', keywords: ['test', 'probe', 'point', 'pad'],
  symbol: S.testPoint(), footprint: F.testPoint(),
});
add({
  id: 'buzzer-12mm', name: 'Buzzer 12mm', category: 'Miscellaneous', prefix: 'BZ', value: 'Buzzer',
  description: 'Magnetic buzzer, 12 mm, through hole, pin 1 positive', keywords: ['buzzer', 'sounder', 'beeper', 'audio'],
  symbol: S.buzzer(), footprint: F.buzzer12(),
});

// ---------------------------------------------------------------- lookup

export const BUILTIN_COMPONENTS = list;

const byId = new Map(list.map((d) => [d.id, d]));

/** Built-in definition by id, or null. */
export const findComponent = (id) => byId.get(id) || null;

/** Deep copy of a definition, safe to embed in a project and edit. */
export function cloneDef(def) {
  return typeof structuredClone === 'function' ? structuredClone(def) : JSON.parse(JSON.stringify(def));
}

// Natural order, so "Header 1x2" comes before "Header 1x10".
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const FIELD_WEIGHTS = [['name', 5], ['id', 4], ['footprint', 4], ['value', 3], ['keywords', 3], ['category', 2], ['description', 1]];
let searchIndex = null;

function buildIndex() {
  searchIndex = list.map((d) => ({
    def: d,
    fields: {
      name: d.name.toLowerCase(),
      id: d.id.toLowerCase(),
      footprint: (d.footprint?.name || '').toLowerCase(),
      value: (d.value || '').toLowerCase(),
      keywords: (d.keywords || []).join(' ').toLowerCase(),
      category: (d.category || '').toLowerCase(),
      description: (d.description || '').toLowerCase(),
    },
  }));
}

/**
 * Searches definitions (built-in by default). Every query token must match
 * some field; matches in names, ids and footprints rank above descriptions,
 * and word starts rank above substrings.
 */
export function searchComponents(query = '', category = null, defs = null) {
  if (!searchIndex) buildIndex();
  const index = defs ? defs.map((d) => ({ def: d, fields: {
    name: (d.name || '').toLowerCase(), id: (d.id || '').toLowerCase(), footprint: (d.footprint?.name || '').toLowerCase(),
    value: (d.value || '').toLowerCase(), keywords: (d.keywords || []).join(' ').toLowerCase(),
    category: (d.category || '').toLowerCase(), description: (d.description || '').toLowerCase(),
  } })) : searchIndex;
  const tokens = String(query).toLowerCase().split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (const entry of index) {
    if (category && entry.def.category !== category) continue;
    let score = 0;
    let ok = true;
    for (const tok of tokens) {
      let best = 0;
      for (const [field, w] of FIELD_WEIGHTS) {
        const text = entry.fields[field];
        const at = text.indexOf(tok);
        if (at < 0) continue;
        const wordStart = at === 0 || /[\s\-_/.(]/.test(text[at - 1]);
        const s = w + (wordStart ? 1 : 0) + (text === tok ? 2 : 0);
        if (s > best) best = s;
      }
      if (!best) { ok = false; break; }
      score += best;
    }
    if (ok) out.push({ def: entry.def, score });
  }
  const order = (d) => {
    const i = CATEGORIES.indexOf(d.category);
    return i < 0 ? CATEGORIES.length : i;
  };
  out.sort((a, b) => b.score - a.score || order(a.def) - order(b.def) || byName.compare(a.def.name, b.def.name));
  return out.map((r) => r.def);
}
