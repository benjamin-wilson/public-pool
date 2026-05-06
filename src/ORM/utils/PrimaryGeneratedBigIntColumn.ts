import { PrimaryGeneratedColumn } from 'typeorm';

export const PrimaryGeneratedBigIntColumn = () => PrimaryGeneratedColumn({
    type: process.env.NODE_ENV === 'test' ? 'integer' : 'bigint'
});
