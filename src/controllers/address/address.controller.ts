import { Controller, Patch } from '@nestjs/common';


@Controller('address')
export class AddressController {

    @Patch('settings')
    async settings() {
        return;
    }
}
