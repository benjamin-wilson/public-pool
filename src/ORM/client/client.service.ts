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

    public async save(client: Partial<ClientEntity>) {
        return await this.clientRepository.save(client);
    }

    public async delete(id: string) {
        return await this.clientRepository.softDelete({ id });
    }

    public async updateBestDifficulty(id: string, bestDifficulty: number) {
        return await this.clientRepository.update(id, { bestDifficulty });
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

    public async getByAddressAndName(address: string, id: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                id
            }
        })
    }
}