import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { setTimeout } from 'timers/promises';
import { IsNull, LessThan, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {

    private bulkInsertClients: ClientEntity[] = [];

    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Cron(CronExpression.EVERY_SECOND)
    private async bulkInsert() {

        if (this.bulkInsertClients.length < 1) {
            return;
        }

        const clientsToInsert = [...this.bulkInsertClients];;
        this.bulkInsertClients = [];
        await this.clientRepository.insert(clientsToInsert);
    }

    public async killDeadClients() {
        var tenMinutes = new Date(new Date().getTime() - (60 * 60 * 1000));

        return await this.clientRepository.update({
            deletedAt: IsNull(),
            updatedAt: LessThan(tenMinutes)
        }, {
            deletedAt: new Date()
        });
    }

    public async heartbeat(address: string, clientName: string, sessionId: string) {
        return await this.clientRepository.update({ address, clientName, sessionId }, { deletedAt: null, updatedAt: new Date() });
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const client = this.clientRepository.create(partialClient);
        this.bulkInsertClients.push(client);
        // wait for the bulk insert to go though
        // while we await node is free to service other requests
        await setTimeout(2000);
        return client;
    }

    public async delete(sessionId: string) {
        return await this.clientRepository.softDelete({ sessionId });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository.update({ sessionId }, { bestDifficulty });
    }
    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository.softDelete({})
    }

    public async getUserAgents() {
        const result = await this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent as userAgent')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

}