import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from './client.entity';




@Injectable()
export class ClientService {

    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    // public async killDeadClients(){
    //     var tenMinutes = new Date(new Date().getTime() - (60 * 60 * 1000));

    //     return await this.clientRepository.update({
    //          deletedAt: IsNull(),
    //          updatedAt: LessThan(tenMinutes)
    //     }, {
    //         deletedAt: new Date()
    //     });
    // }

    public async heartbeat(address: string, clientName: string, sessionId: string) {
        return await this.clientRepository.update({ address, clientName, sessionId }, { deletedAt: null, updatedAt: new Date() });
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }

    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {
        const insertResult = await this.clientRepository.insert(partialClient);

        const client = {
            ...partialClient,
            ...insertResult.generatedMaps[0]
        };

        return client as ClientEntity;
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