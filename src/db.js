import mongoose from 'mongoose';

export async function connectDB(uri) {
  await mongoose.connect(uri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
}

export { mongoose };
