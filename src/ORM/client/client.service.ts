import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, lastValueFrom } from 'rxjs';
import { FindOptionsWhere, ObjectId, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {

    private insertQueue: { client: Partial<ClientEntity>, subject: BehaviorSubject<any> }[] = [];
    private heartbeatQueue: {
        criteria: string | string[] | number | number[] | Date | Date[] | ObjectId | ObjectId[] | FindOptionsWhere<ClientEntity>,
        partialEntity: QueryDeepPartialEntity<ClientEntity>,
        subject: BehaviorSubject<any>
    }[] = [];

    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

        setInterval(async () => {
            if (this.heartbeatQueue.length < 1) {
                return;
            }
            const heartbeatToInsert = [...this.heartbeatQueue];
            this.heartbeatQueue = [];


            await this.clientRepository.manager.transaction(async transactionalEntityManager => {
                for (let i = 0; i < heartbeatToInsert.length; i++) {
                    await this.clientRepository.update(heartbeatToInsert[i].criteria, heartbeatToInsert[i].partialEntity);
                }
            });


            heartbeatToInsert.forEach((val, index) => {
                heartbeatToInsert[index].subject.next(null);
                heartbeatToInsert[index].subject.complete();
            });

        }, 5000);

        setInterval(async () => {
            if (this.insertQueue.length < 1) {
                return;
            }
            const clientsToInsert = [...this.insertQueue];
            this.insertQueue = [];
            const results = await this.clientRepository.insert(clientsToInsert.map(i => i.client));

            results.generatedMaps.forEach((val, index) => {
                clientsToInsert[index].subject.next({ ...clientsToInsert[index].client, ...val });
                clientsToInsert[index].subject.complete();
            });

        }, 5000);
    }


    public async killDeadClients() {
        var fiveMinutes = new Date(new Date().getTime() - (5 * 60 * 1000)).toISOString();

        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => "DATETIME('now')" })
            .where("deletedAt IS NULL AND updatedAt < DATETIME(:fiveMinutes)", { fiveMinutes })
            .execute();
    }

    public async heartbeat(address: string, clientName: string, sessionId: string, hashRate: number) {

        const subject$ = new BehaviorSubject<ClientEntity>(null);
        this.heartbeatQueue.push({
            criteria: { address, clientName, sessionId },
            partialEntity: { hashRate, deletedAt: null, updatedAt: new Date() },
            subject: subject$
        }
        );
        return lastValueFrom(subject$);
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const subject$ = new BehaviorSubject<ClientEntity>(null);
        this.insertQueue.push({ client: partialClient, subject: subject$ });
        return lastValueFrom(subject$);
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
            .addSelect('SUM(client.hashRate)', 'totalHashRate')
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

}