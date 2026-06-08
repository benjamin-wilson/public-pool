import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { createDatabaseOptions } from './database.config';

export const AppDataSource = new DataSource(createDatabaseOptions(process.env));
