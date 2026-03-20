import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    _id:           { type: String },
    name:          { type: String },
    model:         { type: String },
    brand:         { type: String },
    type:          { type: String },
    category:      { type: String },
    category_name: { type: String },
    manufacturer:  { type: String },
    barcode:       { type: String },
    wb: {
      ip:       [String],
      ooo:      [String],
      viplinza: [String],
    },
    params: {
      'Оптическая сила':           mongoose.Schema.Types.Mixed,
      'Оптическая сила цилиндра':  mongoose.Schema.Types.Mixed,
      'Ось линзы':                 mongoose.Schema.Types.Mixed,
      'Аддидация линзы':           mongoose.Schema.Types.Mixed,
      'Радиус кривизны':           mongoose.Schema.Types.Mixed,
      'Диаметр':                   mongoose.Schema.Types.Mixed,
      'Тип линз':                  String,
      'Срок замены':               String,
      'Упаковка':                  mongoose.Schema.Types.Mixed,
      'Цвет':                      mongoose.Schema.Types.Mixed,
    },
  },
  {
    strict: false,
    collection: 'products',
    _id: false,
  }
);

export const Product = mongoose.model('Product', productSchema);
